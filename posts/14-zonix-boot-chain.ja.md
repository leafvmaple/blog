# 電源投入から `kern_init` まで：Zonix のブートチェーンと boot_info 統一プロトコル

> リポジトリ：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> シリーズ：[Zonix OS 設計振り返り #11](https://github.com/leafvmaple/blog/issues/11) の詳細記事
> 対象サブシステム：`arch/x86/boot/{bios,uefi}/` / `arch/x86/kernel/head.S` / `include/kernel/bootinfo.h`

ブートはカーネルで**唯一「足元の地盤が歩きながら崩れる」コード**です。CPU モードを切り替え、ページテーブルを再構築し、スタックを替える —— その各ステップが、次の命令のあるアドレスを無効化し得る。この記事では三つを述べます。

1. BIOS と UEFI というまったく異なる二つのブート経路が、どうカーネルの**同一の入口・同一の `BootInfo`** に収束するか;
2. `head.S` の「物理アドレス上で走るのに仮想アドレスのシンボルを参照する」コードが、`REALLOC` マクロ一つでどう生き延びるか;
3. ブート期で最も直感に反する一歩 —— **CR3 を替えると同時に、まずスタックを替えねばならない**、なぜそれが UEFI 経路で生死を分けるか。

---

## 1. 二つの経路、一つの合流点

x86 で Zonix は二種類のファームウェアをサポートし、「カーネルを見つけ、メモリへ読み込み、64 ビットへ入る」をまったく異なる方法でやり遂げます。

```
BIOS 経路（レガシー）:
  BIOS → MBR(512B, 16bit) → VBR(512B, 16bit, FAT32 を解する)
       → bootload.c(32bit 保護モード, ELF ローダ) → entry.S(32→64 long mode トランポリン)
       → head.S
              ↘
UEFI 経路（モダン）:                                  合流点：head.S、rdi = &BootInfo
  ファームウェア → BOOTX64.EFI(64bit PE32+, efi_main)  ↗
       → Boot Services でカーネル ELF 読込 + framebuffer 取得 + メモリマップ取得 → ExitBootServices
       → head.S
```

BIOS 経路は自分で一段ずつリレーします。MBR はわずか 512 バイトで VBR を読むのが精一杯；VBR は FAT32 を少し解し、カーネルファイルとより大きな bootloader をメモリへ読む；bootloader は 32 ビット保護モードで ELF を解析し、セグメントをロードし、BSS をクリアし、`entry.S` の long mode トランポリンへ跳んで 64 ビットへ切り替える。UEFI 経路はファームウェアの肩に乗ります。ファームウェアは既に 64 ビット long mode で、`BOOTX64.EFI` は直接 Boot Services でファイルを読み、GOP framebuffer を取り、メモリマップを取り、最後に `ExitBootServices()` でマシンを我々へ引き渡す。

**二経路は千差万別だが、`head.S` で合流するときカーネルへまったく同じものを引き渡さねばならない。** これが `BootInfo` プロトコルの意義です（[`6ff8a32`](https://github.com/leafvmaple/zonix-plus/commit/6ff8a32) で両経路を同一の 64 ビット入口へ統一）。

```cpp
struct BootInfo {
    uint32_t magic;              // == BOOT_INFO_MAGIC (0x12345678) 必須、head.S 後の最初の仕事はその検証
    uint32_t mem_lower, mem_upper;
    uint32_t mmap_length;        // メモリマップのエントリ数
    uint64_t mmap_addr;          // BootMemEntry 配列の物理アドレス（PMM がこれで空きページプールを作る）
    uint32_t kernel_start, kernel_end, kernel_entry;
    uint8_t  boot_device;
    // framebuffer（UEFI は GOP を詰め、BIOS text モードは空）
    uint64_t framebuffer_addr;
    uint32_t framebuffer_width, framebuffer_height, framebuffer_pitch;
    uint8_t  framebuffer_bpp, framebuffer_type;   // 0=text, 1=rgb
    char     loader_name[32];    // "Zonix BIOS" または "Zonix UEFI" —— カーネルは誰にブートされたか印字できる
} __attribute__((packed));
```

`x86_64` System V ABI は第一引数を `rdi` で渡すと定めるので、両経路とも `BootInfo*` を `rdi` に置いて `head.S` へ跳ぶ。カーネル側 `kern_init(BootInfo* bi)` の最初の行は：

```cpp
extern "C" [[noreturn]] int kern_init(struct BootInfo* boot_info) {
    if (!boot_info || boot_info->magic != BOOT_INFO_MAGIC)
        arch_halt();   // magic 不一致 → ブートプロトコル破損 → 即停止、病んだまま動かさない
    ...
}
```

> この `magic` は飾りではない。ブート期にはデバッグ設備が一切なく、bootloader とカーネルの `BootInfo` 構造レイアウト理解がずれると（例：フィールド順を変えたが片側しか再コンパイルしていない）、最初に崩れる場所は根本原因から遥か遠いことが多い。冒頭の magic 検証は、「プロトコル不整合」という最も追いにくいバグを、**決定的でその場で停止する**失敗に変える。ネットワークパケットに magic ヘッダを付けるのと同じ理屈です。

`__attribute__((packed))` も必須 —— bootloader 側は別のコンパイル対象かもしれず（UEFI は `clang --target=x86_64-pc-windows-msvc`）、両側でアラインメント規則が一致しなければ構造体オフセットがずれる。packed はバイト詰めレイアウトを強制し、コンパイラの裁量の余地を消す。

---

## 2. `REALLOC`：物理アドレス上で走り、仮想アドレスのシンボルを参照する

`head.S` は最初**物理アドレス**（低位、恒等マップ）で走るが、その中の全シンボル（`__boot_pml4`、`__gdt`…）は**カーネルの仮想アドレス（高位半 `0xFFFFFFFF80000000+`）でリンクされている**。直接 `movq $__boot_pml4, %rdi` すると、今はまだマップされていない高位アドレスを得て、触れた途端アウト。

解は素朴極まりないマクロです。

```asm
#define REALLOC(x) ((x) - KERNEL_BASE)   // 仮想アドレス - 高位半ベース = 対応する物理アドレス
```

カーネルは `KERNEL_BASE + 物理オフセット` にリンクされるので、「仮想アドレスから `KERNEL_BASE` を引く」とちょうど物理アドレスに戻る。高位半マッピングをまだ構築せず低位アドレスで走るこの窓の間、**全シンボル参照に `REALLOC()` を一枚被せる**。

```asm
movq $REALLOC(__boot_pml4), %rdi    # 物理アドレスでページテーブルバッファへアクセス
...
movq $REALLOC(__gdtdesc_phys), %rax
lgdt (%rax)                          # 物理アドレスの GDT 記述子を使う
```

ページテーブル構築後、高位半へ跳んだら、シンボルは本物の仮想アドレスで使える（`lgdt __gdtdesc(%rip)`、RIP-relative）。`REALLOC` の手術は「物理アドレス実行 + シンボルは仮想リンク」というずれた窓の間だけ必要 —— ブートアセンブリで最も間違えやすく、デバッグが最も苦しい類の問題（症状は通常、めちゃくちゃなメモリへのアクセス）であり、明示的なマクロがこれを目視可能な約束に変える：**`REALLOC` が付いている所はすべて、まだ高位半に入っていないコード**。

> aarch64 の `head.S` は別の等価な方法を使う：MMU OFF 段階の全シンボル参照は `adrp/adr`（PC 相対アドレッシング）で、相対レイアウトは物理/仮想で一致するので、PC 相対は本来 VA/PA オフセットの影響を受けない。二つのアーキ、同じ問題（「コード実行アドレス ≠ リンクアドレス」）、各命令セットの習慣に沿った二つの解 —— これこそ [#15 マルチアーキテクチャ抽象](https://github.com/leafvmaple/blog/issues/15) が強調したい点：**抽象しきれず、各アーキで一つずつ書くしかないものはある、だがそれらを `arch/` の最下層に隔離せよ。**

---

## 3. ページテーブル構築 + CR3 切替 + スタック切替：ブート期で最も危険な三連

`head.S` の核心は手で 4 レベルページテーブルを構築し、**二つのマッピング**を作ることです。

```asm
# 恒等マップ:   0x0000_0000_0000_0000 → 0x0000_0000_3FFF_FFFF  (0..1GB、物理=仮想)
# 高位半マップ: 0xFFFF_FFFF_8000_0000 → 物理 0..1GB           (カーネルが最終的に走るアドレス)
```

なぜ**同時に**この二つが要るか？ページテーブル切替（CR3 書き込み）は原子的な一瞬だからです。書く前は旧テーブル、書いた直後は新テーブル。新テーブルに高位半マップしか無ければ、CR3 を書いた次の命令 —— そのアドレスはまだ低位（恒等域）—— が即座にマッピングを失い、その場でフォルト。だから新テーブルは**恒等マップを残し（「切替の瞬間に実行中の低位コード」を生かす）、かつ高位半マップを足す（カーネルが跳べるように）**必要がある。CR3 を替え、高位半へ跳んだら、恒等マップを消す。

```asm
movq $REALLOC(__boot_pml4), %rax
movq %rax, %cr3              # 切替：新旧とも低位を恒等マップ、だからこの命令の次も生きている

# ... GDT 再ロード、高位半 _start64_high へ跳ぶ ...

_start64_high:
    movq $0, __boot_pml4(%rip)   # 今や高位半で走っている、恒等マップ PML4[0] を安全に消せる
    movq %cr3, %rax
    movq %rax, %cr3              # TLB を刷新して消去を有効化
```

しかし最も隠れた地雷は**スタック**です。このコメントとコードを見てください。

```asm
# 安全な低位アドレスに一時スタックを置く。
# これは UEFI 経路で生死を分ける：UEFI ファームウェアのスタックは 1GB 超かもしれないが、
# 我々の新テーブルは 0..1GB しか恒等マップしていない。CR3 を替えた後、高位アドレススタックへの
# アクセスはフォルトする。（BIOS 経路の RSP は元々 0x7000 でこの問題は無い。）
movq $0x7000, %rsp          # ★ CR3 を替える前に、スタックを低位へ移す

movq $REALLOC(__boot_pml4), %rax
movq %rax, %cr3
```

これがブート期で最も直感に反する一歩：**ページテーブル切替はコードアドレスだけでなくスタックアドレスにも効く。** UEFI ファームウェアが引き渡すとき、RSP はファームウェアが割り当てたある高位スタックを指しているかもしれない。我々の新テーブルにその高位アドレスは無い —— だから `mov %rax, %cr3` が実行された途端、次の `push`/`call`/`ret` がスタックに触れてフォルト死。修正は CR3 を替える**前**に RSP を `0x7000`（必ず恒等マップに覆われる低位アドレス）へ移すこと。BIOS 経路は bootloader がとうにスタックを低位に置いていたため偶然この地雷を避け、よってこのバグは UEFI 経路でのみ顕在化 —— またも「ブート経路を替えるのは一種の fuzzing」の例です（[#12](https://github.com/leafvmaple/blog/issues/12) のコンパイラを替えて `switch_to` バグが暴かれた同型の物語を参照）。

> 教訓：「アドレス → 内容」のマッピングを変える操作（CR3 切替、TTBR 切替、GDT 変更、relocate）はすべて、こう問え：**「今まさに踏んでいる各地（コード、スタック、これからアクセスするデータ）は新マッピングでまだ存在するか？」** ブート期のほとんどの triple fault は、切替の瞬間にどこかの「足元の地」が崩れたもの。これをチェックリストにすれば、QEMU を繰り返し再起動しながら呆然とする時間を大量に節約できる。

高位半へ跳び、恒等マップを消した後は平凡です。BSS をクリア（bootloader はセグメントをロードするだけで未初期化データのゼロ化はしない）、本物のカーネルスタックを設定、`lidt` で割り込みテーブルをロード、保存した `BootInfo` 物理アドレスを `rdi` に置き、`call kern_init`。制御はついに C++ へ渡る。

---

## 4. 工学的細部：boot_info は BSS クリアを避けねばならない

踏みやすい小さな罠があります。カーネル起動早期に `rep stosb` で BSS をクリアしますが、`BootInfo` は bootloader から複製してカーネルに保持しているもの —— もし BSS に置かれると、このクリアで消される。`head.S` はカーネルの `BootInfo` 複製を BSS ではなく明示的に `.data` に置きます。

```asm
.section .data            # 注意：.bss ではなく .data
.align 8
__kernel_boot_info:
    .fill BOOT_INFO_SIZE, 1, 0
```

しかも複製動作は BSS クリアの**前**に起きる（`head.S` に入って最初の仕事が `rep movsb` で bootloader の boot_info を `REALLOC(__kernel_boot_info)` へ移すこと）。`.data`（初期値あり、クリアされない）と `.bss`（初期値なし、起動時クリア）の違いは、普段アプリコードを書く分には気にしないが、「自分で自分の BSS をクリアする」カーネルブートでは、置く場所を間違えると framebuffer アドレスやメモリマップが全部ゼロになる奇怪なバグになる。

---

## 5. 更新履歴

<!-- ブートチェーンの今後の進化はここに、時系列降順で。各項に commit リンク + 一言。 -->

- 2026-04-07：[`4d92e4f`](https://github.com/leafvmaple/zonix-plus/commit/4d92e4f) UEFI ブートフローを整理し riscv64 CI を追加；[`45637c7`](https://github.com/leafvmaple/zonix-plus/commit/45637c7) UEFI ブート補助コードを収束、Bochs サポートを除去、ブート経路をさらに統一。
- 2026-03-12：[`921ea7b`](https://github.com/leafvmaple/zonix-plus/commit/921ea7b) / [`f006423`](https://github.com/leafvmaple/zonix-plus/commit/f006423) UEFI と BIOS の bootloader を C から C++ へ移行、エンコード規約を統一；[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166) UEFI ツールチェーンを MinGW GCC から `clang --target=x86_64-pc-windows-msvc` + `lld-link` へ（[#17](https://github.com/leafvmaple/blog/issues/17) 参照）。
- 2026-02-12：[`6ff8a32`](https://github.com/leafvmaple/zonix-plus/commit/6ff8a32) BIOS / UEFI を同一の 64 ビット `head.S` 入口へ統一し kernel config システムを導入；[`501c4b8`](https://github.com/leafvmaple/zonix-plus/commit/501c4b8) 32→64 long mode 切替を `entry.S` に抽出し bootlib を共有（§1 参照）。

---

*本記事は [Zonix OS 設計振り返り](https://github.com/leafvmaple/blog/issues/11) シリーズの詳細記事です。他の記事は振り返り本編末尾のインデックスから。*
