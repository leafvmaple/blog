# PTE の上位 56 ビットはタダで使える swap テーブル

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`mm/vmm.cpp` / `mm/swap.cpp` / `mm/swap_fifo.cpp` / `mm/pmm.cpp`

x86_64 の PTE は 64 ビット。Intel SDM Vol.3A §4.5（"4-Level Paging and 5-Level Paging"）/ Table 4-19 がこの 64 ビットを定めている：bit 0 は present、bit 1 は R/W、bit 2 は U/S、bit 12-51 は物理ページアドレス（4K ページの場合）、bit 52-62 は OS ソフトウェア可用、bit 63 は NX。CPU のハードウェアページテーブルウォーカは `present=1` のときだけこのエントリを認め、`present=0` なら即 page fault を投げ、**残りの 63 ビットを一切見ない**。

`kernel/mm/swap.cpp` + `swap_fifo.cpp` は合計 273 行で demand paging + FIFO swap を実装するが、すべて PTE の 63 個のソフトウェア可用ビットを使って三つのことを行う：

1. ページフォルトハンドラは PTE 自体で「このページは一度も割り当てられていない」と「スワップアウトされた」の二状態を区別、追加のビットマップは持たない；
2. swap サブシステムは `<va, swap_slot>` 逆引きテーブルを維持せず、ディスクスロット番号を**元の PTE に直接エンコード**する；
3. スワップアウトする victim を選ぶときは物理アドレスしか手元に無いので、ページテーブルを逆走査して仮想アドレスへ戻る（rmap 無し）。

---

## 1. PTE をタグ付き union として使う：三状態 + フォルト分岐

Zonix は `present=0` のときの 63 ビットの自由度を使って、PTE を三状態のタグ付き union にした（`arch/x86/include/asm/page.h` の `VM_PRESENT = PTE_P = 0x001`、SDM のあの bit 0）：

| PTE の値 | 意味 | フォルト時の処理 |
|---|---|---|
| `0`（全ゼロ） | この仮想アドレスは一度もマップされていない | **新しい物理ページを割り当て**（匿名 demand-zero ページ） |
| `present=1` | 物理ページにマップ済み | フォルトしない（権限不一致を除く） |
| `present=0` だが `!= 0` | スワップアウト済み、上位に swap スロット番号 | **ディスクからスワップイン** |

ページフォルトハンドラ `vmm::pg_fault` のロジック全体がこの表です。

```cpp
int pg_fault(MemoryDesc* mm, uint32_t error_code, uintptr_t addr) {
    addr = round_down(addr, PG_SIZE);

    pte_t* ptep = pmm::get_pte(mm->pgdir, addr, /*create=*/1);  // 葉 PTE まで辿る（必要なら作る）
    if (*ptep == 0) {
        // 全ゼロ → 未マップ → 新ページ割り当て
        pmm::pgdir_alloc_page(mm->pgdir, addr, VM_USER);
    } else {
        // 非ゼロだがフォルトした → present は必ず 0 → swap entry → スワップイン
        Page* page = nullptr;
        swap::in(mm, addr, &page);
    }
    return 0;
}
```

このコードは「割り当てるべきか、スワップインすべきか」を判断する追加メタデータを一切必要としない —— 判定基準は PTE 自身の値に完全に隠れている。CPU はフォルト時に障害アドレスを CR2 に置き（SDM Vol.3A §4.7、`arch_fault_addr()` で読む）、ハンドラはそのアドレスで PTE まで辿り、0 か否かを一目見れば分岐が分かる。追加のビットマップも「スワップアウト済みページ」リストの検索も無い。

---

## 2. スワップアウト：ページ番号を PTE に書き、present ビットをクリア

`swap::out` はフォルトの逆操作。victim ページを選び、ディスクへ書き、**ディスク位置を swap entry にエンコードして PTE へ書き戻す**。

```cpp
int out(MemoryDesc* mm, int n, int in_tick) {
    static uint32_t swap_offset = 1;   // グローバル swap スロット割り当てカーソル

    for (int i = 0; i < n; i++) {
        Page* victim = nullptr;
        swap_mgr.swap_out_victim(mm, &victim, in_tick);     // FIFO で victim 選択（§4）

        uintptr_t va = find_vaddr_for_page(mm, victim);     // 物理ページ → 仮想アドレス（§3）
        pte_t* ptep  = pmm::get_pte(mm->pgdir, va, 0);

        uintptr_t swap_entry = (swap_offset << 8);          // ★ スロット番号を 8 ビット左シフト、下位 8 ビットに present=0
        swapfs_write(swap_entry, victim);                   // ページ内容を対応セクタへ書く
        *ptep = swap_entry;                                 // ★ PTE は今「ディスクの何番スロットか」を保持

        pmm::tlb_invl(mm->pgdir, va);                       // CPU キャッシュの旧マッピングを無効化
        pmm::free_pages(victim, 1);                         // 物理ページをアロケータへ返却

        if (++swap_offset >= max_swap_offset) swap_offset = 1;  // 環状に再利用
    }
    return i;
}
```

`swap_entry = (swap_offset << 8)` の行に注目：スロット番号を 8 ビット左シフトすると、**最下位 8 ビットは自然に全ゼロで、その中に present ビットが含まれる**。だからこの値を PTE に書くと、CPU は `present=0` を見て次回アクセスでフォルトし、ソフトウェアは PTE を 8 ビット右シフトしてスロット番号を取り戻す。一つの 64 ビットワードが、ハードウェア（present=0 でフォルト）とソフトウェア（上位にスロット番号）というまったく異なる二人の読者を同時に満たす。

スワップイン（`swap::in`）はその鏡像です。

```cpp
Error in(MemoryDesc* mm, uintptr_t addr, Page** page_ptr) {
    Page* page = pmm::alloc_pages(1);                  // 空き物理ページを取得
    pte_t* ptep = pmm::get_pte(mm->pgdir, addr, 0);
    uintptr_t swap_entry = *ptep;                      // PTE に入っているのがスロット番号エンコード
    swapfs_read(swap_entry, page);                     // ディスクから内容をこのページへ読む

    pmm::page_insert(mm->pgdir, page, addr, VM_USER_RW);   // present=1 のマッピングを再構築
    swap_mgr.map_swappable(mm, addr, page, 1);         // FIFO キューへ再挂
    *page_ptr = page;
    return Error::None;
}
```

swap entry からディスクセクタへの換算は、スロット番号を「ページサイズの何番目のブロックか」とみなし、固定の開始セクタから後ろへ並べるだけ。

```cpp
// PTE: [ スロット番号 (上位) | 下位 8 ビットに present=0 ]
uint32_t offset = (entry >> 8) & 0xFFFFFF;                       // スロット番号を取り戻す
uint32_t sector = SWAP_START_SECTOR + offset * SECTORS_PER_PAGE; // ディスクセクタを算出
swap_device->read(sector, page_to_kva(page), SECTORS_PER_PAGE);
```

`SECTORS_PER_PAGE = PG_SIZE / 512 = 8`、1 ページは 8 セクタ。このエンコード一式により、**swap サブシステムは全行程で「仮想アドレス → ディスク位置」のマッピングテーブルを一切保持しない** —— そのマッピングは PTE 自身です。「既存のデータ構造を再利用する」を極めた一例です。

---

## 3. ページテーブル逆走査：物理ページから仮想アドレスを逆算

上の `swap::out` にさらりと `find_vaddr_for_page(mm, victim)` の行がありますが、これは実問題を解いています：**FIFO が選んだ victim は `Page*`（物理ページ記述子）で、分かるのは物理アドレスだけ。だが「スワップアウト済み」に印を付けるには対応 PTE を変更せねばならず、PTE は仮想アドレスでインデックスされる。物理ページ自体は「誰が私を使っているか」を知らない。**

順方向（VA → PA）はハードウェアの仕事で、4 レベルページテーブルを辿ればよい。逆方向（PA → VA）はハードウェア支援が無く、**ページテーブルツリー全体を走査**して、どの葉 PTE がこの物理アドレスを指すかを探すしかない。

```cpp
// depth: 0=PML4, 1=PDPT, 2=PD, 3=PT(葉)
uintptr_t scan_pt_for_pa(const pde_t* table, int depth, uintptr_t va_base, uintptr_t target_pa) {
    int  shift   = LEVEL_SHIFTS[depth];          // この層の各 entry がカバーするアドレス幅
    bool is_leaf = (depth == PAGE_LEVELS - 1);

    for (int i = 0; i < PAGE_TABLE_ENTRIES; i++) {
        pde_t entry = table[i];
        if (!(entry & VM_PRESENT)) continue;     // 空洞はスキップ

        uintptr_t va = va_base | (uintptr_t(i) << shift);   // このエントリが表す VA プレフィックスを組む

        if (is_leaf) {
            if (pte_addr(entry) == target_pa) return va;     // 命中：この物理ページをマップする VA
            continue;
        }
        if (pte_is_block(entry)) {               // 2MB/1GB 大ページ：ブロック範囲内も命中
            uintptr_t block_pa = pte_addr(entry), block_sz = 1UL << shift;
            if (target_pa >= block_pa && target_pa < block_pa + block_sz)
                return va | (target_pa - block_pa);
            continue;
        }
        // 中間層：次のレベルへ再帰
        uintptr_t r = scan_pt_for_pa(phys_to_virt<pde_t>(pte_addr(entry)), depth + 1, va, target_pa);
        if (r != 0) return r;
    }
    return 0;
}
```

深さ優先のページテーブル走査で、各層で `LEVEL_SHIFTS[depth]` を使ってその層の entry インデックスに対応する仮想アドレスビット段を復元し、`va_base | (i << shift)` で完全な VA を組み上げる。大ページ（block entry、2MB または 1GB）に遭遇したら target_pa のブロック内オフセットを VA 下位に補う。

これは O(ページテーブル規模) の逆走査で、本番 OS のやり方ではない —— Linux は `struct page` 上の逆マッピング（rmap）+ `anon_vma`（[`include/linux/rmap.h`](https://github.com/torvalds/linux/blob/master/include/linux/rmap.h) 参照）で PA→VA を行い、スワップアウトのたびの全表走査を避けている。Zonix の教育的規模では、この逆走査関数は 30 行、追加状態ゼロ、読めば一目瞭然；本当に性能圧力が出てから rmap を入れても遅くない。ソースコメントに「ここは既知の、許容可能な遅さ」と明記されている。

---

## 4. FIFO 置換：per-mm の一本の侵入型キュー

victim 選択のポリシーは `SwapManager` に分離され、現実装は最も単純な FIFO。その「キュー」は別の配列ではなく、**`Page` 記述子に埋め込まれたリストノードを再利用**し、各アドレス空間（`MemoryDesc`）が自分の `swap_list` を持ちます。

```cpp
// ページが「スワップ可能」になったら末尾へ挂ける
Error SwapManager::map_swappable(MemoryDesc* mm, uintptr_t addr, Page* page, int swap_in) {
    mm->swap_list.add_before(page->node());   // 侵入型：リストノードは Page 内にある
    return Error::None;
}

// victim 選択：先頭（最も早く入った）を取る
Error SwapManager::swap_out_victim(MemoryDesc* mm, Page** page_ptr, int in_tick) {
    if (mm->swap_list.empty()) { *page_ptr = nullptr; return Error::NotFound; }
    ListNode* victim = mm->swap_list.get_next();   // FIFO：先頭を出す
    victim->unlink();
    *page_ptr = victim->container<Page>();
    return Error::None;
}
```

設計上の二点を述べます。

- **per-mm キュー、共有しない**：各アドレス空間が自分のスワップアウト順序を維持し、異なるプロセスのページを一本のグローバルキューに混ぜない。コメントに意図的だと明記（`do not share FIFO state across address spaces`）—— さもないと一つのプロセスのスワップアウトのリズムが別のを汚染する。
- **侵入型リスト**：`Page` が `node()` を内蔵し、出入りに割り当てゼロ。これはスケジューラの `TaskStruct` が `list_node` を内蔵、WaitQueue の entry が `node` を内蔵するのと同じカーネル慣用法 —— **カーネルではリストノードはほぼ常に被リンク要素の内部に埋め込む**、挂けるために余分な malloc をしないため（ページフォルト経路で malloc するとさらにフォルトを誘発し得る、再帰地獄）。

ポリシーとメカニズムは例によって分離：`SwapManager` は「誰を換えるか」だけ答え、`swap::out`/`swap::in` は「どう換えるか」を担う。LRU / Clock / セカンドチャンスに替えたければ `swap_out_victim` と `map_swappable` を差し替えるだけで、フォルト経路と PTE エンコードは不変。

---

## 5. 直交する小設計：MMIO 仮想アドレスアロケータ

仮想メモリ層はついでにデバイスメモリのマッピングも解決します。通常メモリのカーネルマッピングは「高位半 = 物理アドレス + 固定オフセット」で、VA と PA に単純な算術関係がある。しかし MMIO（例：AHCI の HBA レジスタ）はそうはいかない —— その物理アドレスは PCI BAR が与えるもので、任意の上位にあり得て、そのオフセットを当てはめられない。

そこで `mmio_map` は**独立した、`KERNEL_DEVIO_BASE` から増加する仮想アドレスカーソル**を維持し、VA と PA の間に意図的に算術関係を持たせません。

```cpp
static uintptr_t mmio_next_va = KERNEL_DEVIO_BASE;

uintptr_t mmio_map(uintptr_t phys_addr, size_t size, uint32_t perm) {
    size = round_up(size, PG_SIZE);
    uintptr_t va = mmio_next_va;
    pgdir_init(boot_pgdir, va, size, phys_addr, perm);   // va → phys_addr のマッピングを構築
    arch_flush_tlb_range(va, size);                      // この範囲の TLB を刷新、旧 2MB ブロックマッピング残留を防ぐ
    mmio_next_va += size;
    return va;
}
```

ドライバは `auto* regs = (HbaRegs*)mmio_map(bar_phys, size, VM_WRITE | VM_PCD)` するだけで、直接デリファレンスできるカーネル仮想アドレスを得て、物理アドレスがどこかを一切気にしない。`arch_flush_tlb_range`（[`c16cf25`](https://github.com/leafvmaple/zonix-plus/commit/c16cf25) で抽出したアーキ非依存の TLB 刷新）が、新マッピングが旧大ページ TLB キャッシュに隠されないことを保証する。

---

## 6. 更新履歴

<!-- メモリ管理 / swap の今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-04-03：[`c16cf25`](https://github.com/leafvmaple/zonix-plus/commit/c16cf25) アーキ非依存の `arch_flush_tlb_range` を抽出し、VMM / `mmio_map` で統一使用（§5 参照）。x86 は逐ページ `invlpg`、aarch64 は `tlbi` —— VMM はもう気にしない。
- 2026-03-20：[`5a00a65`](https://github.com/leafvmaple/zonix-plus/commit/5a00a65) MMIO アクセスとページアロケータ抽象を統一；[`2e6847f`](https://github.com/leafvmaple/zonix-plus/commit/2e6847f) `page2pa/pa2page` 等の変換 API をリネーム（→ `pmm::page_to_phys` 等）、ページテーブル割り当てフローを安定化。
- 2026-01-29：[`27e6267`](https://github.com/leafvmaple/zonix-plus/commit/27e6267) PMM マネージャを C struct から C++ クラスへ書き換え、first-fit アロケータ + 参照カウントをオブジェクトに収める。

---

*リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本記事は [Zonix OS シリーズ](https://github.com/leafvmaple/blog/issues/11) の一篇。*
