<!--pub:2025-10-25-->
# PTE 高 56 位是免费的 swap 表

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`mm/vmm.cpp` / `mm/swap.cpp` / `mm/swap_fifo.cpp` / `mm/pmm.cpp`

x86_64 的 PTE 是 64 位。Intel SDM Vol.3A §4.5（"4-Level Paging and 5-Level Paging"）/ Table 4-19 把这 64 位钉死：bit 0 present，bit 1 R/W，bit 2 U/S，bit 12-51 物理页地址（4K 页），bit 52-62 OS 软件可用，bit 63 NX。CPU 的硬件页表遍历器只在 `present=1` 时才认这一项；`present=0` 时直接抛 page fault，**剩下的 63 位它根本不看**。

`kernel/mm/swap.cpp` + `swap_fifo.cpp` 共 273 行实现了 demand paging + FIFO swap，靠的全是用 PTE 这 63 个软件可用位做三件事：

1. 缺页处理器用 PTE 本身区分"这页从没分配过"与"这页被换出去了"两态，不要任何额外位图；
2. swap 子系统不维护 `<va, swap_slot>` 反查表，把磁盘槽号**直接编码进原 PTE**；
3. 选中要换出的 victim 时只有物理地址，反向扫页表回到虚拟地址（无 rmap）。

---

## 1. PTE 当 tagged union 用：三态 + 缺页分支

Zonix 用 `present=0` 时那 63 位的自由度，把 PTE 变成一个三态的 tagged union（`arch/x86/include/asm/page.h` 里 `VM_PRESENT = PTE_P = 0x001`，就是 SDM 那个 bit 0）：

| PTE 的值 | 含义 | 缺页时怎么办 |
|---|---|---|
| `0`（全零） | 这个虚拟地址从未被映射 | **分配一个新物理页**（匿名页 demand-zero） |
| `present=1` | 已映射到物理页 | 不会缺页（除非权限不符） |
| `present=0` 但 `!= 0` | 页被换出了，高位存着 swap 槽号 | **从磁盘换回来** |

缺页处理器 `vmm::pg_fault` 整个逻辑就是这张表：

```cpp
int pg_fault(MemoryDesc* mm, uint32_t error_code, uintptr_t addr) {
    addr = round_down(addr, PG_SIZE);

    pte_t* ptep = pmm::get_pte(mm->pgdir, addr, /*create=*/1);  // 走到（必要时建出）叶子 PTE
    if (*ptep == 0) {
        // 全零 → 从未映射 → 分配一个新页
        pmm::pgdir_alloc_page(mm->pgdir, addr, VM_USER);
    } else {
        // 非零但触发了缺页 → present 必为 0 → 它是个 swap entry → 换回来
        Page* page = nullptr;
        swap::in(mm, addr, &page);
    }
    return 0;
}
```

这段代码不需要任何额外元数据来判断"这页该分配还是该换回" —— 判据完全藏在 PTE 自己的值里。CPU 触发缺页时把出错地址放进 CR2（SDM Vol.3A §4.7，`arch_fault_addr()` 读它），处理器拿地址走到 PTE，看一眼是不是 0 就知道分支。没有额外位图、没有"已换出页"链表查询。

---

## 2. 换出：把页号写进 PTE，present 位清零

`swap::out` 是缺页的反向操作。它选一个 victim 页，写到磁盘，然后**把磁盘位置编码成一个 swap entry 写回 PTE**：

```cpp
int out(MemoryDesc* mm, int n, int in_tick) {
    static uint32_t swap_offset = 1;   // 全局 swap 槽分配游标

    for (int i = 0; i < n; i++) {
        Page* victim = nullptr;
        swap_mgr.swap_out_victim(mm, &victim, in_tick);     // FIFO 选 victim（见 §4）

        uintptr_t va = find_vaddr_for_page(mm, victim);     // 物理页 → 虚拟地址（见 §3）
        pte_t* ptep  = pmm::get_pte(mm->pgdir, va, 0);

        uintptr_t swap_entry = (swap_offset << 8);          // ★ 槽号左移 8 位，低 8 位含 present=0
        swapfs_write(swap_entry, victim);                   // 把页内容写到磁盘对应扇区
        *ptep = swap_entry;                                 // ★ PTE 现在存的是"在磁盘第几槽"

        pmm::tlb_invl(mm->pgdir, va);                       // 让 CPU 缓存的旧映射失效
        pmm::free_pages(victim, 1);                         // 物理页归还分配器

        if (++swap_offset >= max_swap_offset) swap_offset = 1;  // 环形复用
    }
    return i;
}
```

注意那行 `swap_entry = (swap_offset << 8)`：槽号左移 8 位，**最低 8 位天然全是 0，其中就包含 present 位**。所以这个值写进 PTE 后，CPU 看 `present=0`，下次访问就缺页；而我们软件读这个 PTE，右移 8 位就拿回了槽号。一个 64 位字同时满足了硬件（present=0 触发缺页）和软件（高位存槽号）两个完全不同的读者。

换回来（`swap::in`）就是镜像：

```cpp
Error in(MemoryDesc* mm, uintptr_t addr, Page** page_ptr) {
    Page* page = pmm::alloc_pages(1);                  // 拿一个空闲物理页
    pte_t* ptep = pmm::get_pte(mm->pgdir, addr, 0);
    uintptr_t swap_entry = *ptep;                      // PTE 里存的就是槽号编码
    swapfs_read(swap_entry, page);                     // 从磁盘把内容读回这个页

    pmm::page_insert(mm->pgdir, page, addr, VM_USER_RW);   // 重新建立 present=1 的映射
    swap_mgr.map_swappable(mm, addr, page, 1);         // 重新挂回 FIFO 队列
    *page_ptr = page;
    return Error::None;
}
```

而 swap entry 到磁盘扇区的换算，就是把槽号当成"第几个页大小的块"，从一个固定起始扇区往后排：

```cpp
// PTE: [ 槽号 (高位) | 低 8 位含 present=0 ]
uint32_t offset = (entry >> 8) & 0xFFFFFF;                       // 取回槽号
uint32_t sector = SWAP_START_SECTOR + offset * SECTORS_PER_PAGE; // 算出磁盘扇区
swap_device->read(sector, page_to_kva(page), SECTORS_PER_PAGE);
```

`SECTORS_PER_PAGE = PG_SIZE / 512 = 8`，一页占 8 个扇区。整套编码下来，**swap 子系统全程没有维护任何"虚拟地址 → 磁盘位置"的映射表** —— 这个映射就是 PTE 本身。这是把"复用现有数据结构"做到极致的一个例子。

---

## 3. 反向扫页表：从物理页倒推它的虚拟地址

上面 `swap::out` 里有一行轻描淡写的 `find_vaddr_for_page(mm, victim)`，但它解决的是一个真问题：**FIFO 选出的 victim 是一个 `Page*`（物理页描述符），我们只知道它的物理地址；可是要把它标记成"已换出"，必须改它对应的 PTE，而 PTE 是按虚拟地址索引的。** 物理页本身不知道"谁在用我"。

正向（VA → PA）是硬件的活，走四级页表即可。反向（PA → VA）没有硬件支持，只能**遍历整棵页表树**，找哪个叶子 PTE 指向这个物理地址：

```cpp
// depth: 0=PML4, 1=PDPT, 2=PD, 3=PT(叶子)
uintptr_t scan_pt_for_pa(const pde_t* table, int depth, uintptr_t va_base, uintptr_t target_pa) {
    int  shift   = LEVEL_SHIFTS[depth];          // 该层每个 entry 覆盖的地址跨度
    bool is_leaf = (depth == PAGE_LEVELS - 1);

    for (int i = 0; i < PAGE_TABLE_ENTRIES; i++) {
        pde_t entry = table[i];
        if (!(entry & VM_PRESENT)) continue;     // 跳过空洞

        uintptr_t va = va_base | (uintptr_t(i) << shift);   // 拼出这一项代表的 VA 前缀

        if (is_leaf) {
            if (pte_addr(entry) == target_pa) return va;     // 命中：找到映射这个物理页的 VA
            continue;
        }
        if (pte_is_block(entry)) {               // 2MB/1GB 大页：落在块范围内也算命中
            uintptr_t block_pa = pte_addr(entry), block_sz = 1UL << shift;
            if (target_pa >= block_pa && target_pa < block_pa + block_sz)
                return va | (target_pa - block_pa);
            continue;
        }
        // 中间层：递归下一级
        uintptr_t r = scan_pt_for_pa(phys_to_virt<pde_t>(pte_addr(entry)), depth + 1, va, target_pa);
        if (r != 0) return r;
    }
    return 0;
}
```

这是一个深度优先的页表遍历，每层用 `LEVEL_SHIFTS[depth]` 还原出该层 entry 索引对应的虚拟地址比特段，一路 `va_base | (i << shift)` 拼出完整 VA。遇到大页（block entry，2MB 或 1GB）还要算 target_pa 在块内的偏移补回 VA 低位。

这是 O(页表规模) 的反向扫描，不是生产级 OS 的做法 —— Linux 用 `struct page` 上的反向映射（rmap）+ `anon_vma`（见 [`include/linux/rmap.h`](https://github.com/torvalds/linux/blob/master/include/linux/rmap.h)）做 PA→VA，正是为了避免每次换出都全表扫描。Zonix 的教学规模下，这条反向扫描函数 30 行、零额外状态、读起来一目了然；等真有性能压力再上 rmap 不迟。源码注释里明确标记了"这里是已知的、可接受的慢"。

---

## 4. FIFO 替换：per-mm 的一条侵入式队列

选 victim 的策略被单独抽成 `SwapManager`，当前实现是最简单的 FIFO。它的"队列"不是另开一个数组，而是**复用 `Page` 描述符里内嵌的链表节点**，每个地址空间（`MemoryDesc`）挂一条自己的 `swap_list`：

```cpp
// 一个页变得"可换出"时，挂到队尾
Error SwapManager::map_swappable(MemoryDesc* mm, uintptr_t addr, Page* page, int swap_in) {
    mm->swap_list.add_before(page->node());   // 侵入式：链表节点就在 Page 里
    return Error::None;
}

// 选 victim：取队头（最早进来的）
Error SwapManager::swap_out_victim(MemoryDesc* mm, Page** page_ptr, int in_tick) {
    if (mm->swap_list.empty()) { *page_ptr = nullptr; return Error::NotFound; }
    ListNode* victim = mm->swap_list.get_next();   // FIFO：队头出
    victim->unlink();
    *page_ptr = victim->container<Page>();
    return Error::None;
}
```

两个设计点值得说：

- **per-mm 队列，不共享**：每个地址空间维护自己的换出顺序，不把不同进程的页混在一条全局队列里。注释里写明这是有意为之（`do not share FIFO state across address spaces`）——否则一个进程的换出节奏会污染另一个。
- **侵入式链表**：`Page` 自带 `node()`，进出队列零分配。这和调度器里 `TaskStruct` 自带 `list_node`、WaitQueue 里 entry 自带 `node` 是同一个内核惯用法——**内核里链表节点几乎总是嵌在被链元素内部**，避免为了挂链而额外 malloc（在缺页路径里 malloc 还可能再触发缺页，递归地狱）。

策略和机制照例是分开的：`SwapManager` 只回答"换谁"，`swap::out`/`swap::in` 负责"怎么换"。想换成 LRU / Clock / 二次机会算法，只需替换 `swap_out_victim` 和 `map_swappable`，缺页路径和 PTE 编码完全不动。

---

## 5. 一个正交的小设计：MMIO 虚拟地址分配器

虚拟内存这一层还顺手解决了设备内存映射。普通内存的内核映射是"高半区 = 物理地址 + 固定偏移"，VA 和 PA 有简单算术关系。但 MMIO（比如 AHCI 的 HBA 寄存器）不行——它的物理地址是 PCI BAR 给的，可能在任意高位，没法套那个偏移。

所以 `mmio_map` 维护一个**独立的、从 `KERNEL_DEVIO_BASE` 起递增的虚拟地址游标**，VA 和 PA 之间故意没有任何算术关系：

```cpp
static uintptr_t mmio_next_va = KERNEL_DEVIO_BASE;

uintptr_t mmio_map(uintptr_t phys_addr, size_t size, uint32_t perm) {
    size = round_up(size, PG_SIZE);
    uintptr_t va = mmio_next_va;
    pgdir_init(boot_pgdir, va, size, phys_addr, perm);   // 建立 va → phys_addr 的映射
    arch_flush_tlb_range(va, size);                      // 刷新这段 TLB，防止旧的 2MB 块映射残留
    mmio_next_va += size;
    return va;
}
```

驱动只管 `auto* regs = (HbaRegs*)mmio_map(bar_phys, size, VM_WRITE | VM_PCD)`，拿到一个能直接解引用的内核虚拟地址，完全不关心物理地址在哪。`arch_flush_tlb_range`（[`c16cf25`](https://github.com/leafvmaple/zonix-plus/commit/c16cf25) 抽出的架构无关 TLB 刷新）确保新映射不被旧的大页 TLB 缓存掩盖。

---

## 6. 迭代记录

<!-- 后续内存管理 / swap 的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-04-03：[`c16cf25`](https://github.com/leafvmaple/zonix-plus/commit/c16cf25) 抽出架构无关的 `arch_flush_tlb_range`，并在 VMM / `mmio_map` 里统一使用（见 §5）。x86 走逐页 `invlpg`，aarch64 走 `tlbi` —— VMM 不再关心。
- 2026-03-20：[`5a00a65`](https://github.com/leafvmaple/zonix-plus/commit/5a00a65) 统一 MMIO 访问与页分配器抽象；[`2e6847f`](https://github.com/leafvmaple/zonix-plus/commit/2e6847f) 重命名 `page2pa/pa2page` 等转换 API（→ `pmm::page_to_phys` 等），并稳定页表分配流程。
- 2026-01-29：[`27e6267`](https://github.com/leafvmaple/zonix-plus/commit/27e6267) 把 PMM 管理器从 C struct 改写为 C++ 类，first-fit 分配器 + 引用计数收进对象。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
