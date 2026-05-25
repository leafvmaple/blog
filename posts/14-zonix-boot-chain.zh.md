<!--pub:2026-02-10-->
# BIOS 与 UEFI 在 `head.S` 汇合：`rdi=&BootInfo`

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`arch/x86/boot/{bios,uefi}/` / `arch/x86/kernel/head.S` / `include/kernel/bootinfo.h`

x86 上 zonix-plus 同时支持 BIOS 和 UEFI 两种固件，最终产物从不同入口出发但都跳进同一个 `head.S`：

```
bin/x86/mbr         3,744 字节   .text 段 512 字节 (16-bit real mode)
bin/x86/vbr         6,408 字节   .text 段 512 字节 (16-bit real mode, 懂 FAT32)
bin/x86/bootloader  19,100 字节  (32-bit protected mode, ELF loader)
arch/x86/kernel/head.S  255 行   x86 BIOS / UEFI / 高半区切换的汇合点
```

引导期是内核里**脚下的地基边走边塌**的一段代码：要切换 CPU 模式（real → protected → long）、重建页表（恒等映射 → 高半区映射）、换栈，每一步都可能让下一条指令所在的地址失效。这一篇看四件事 —— BIOS / UEFI 双路径如何汇合到 `head.S` 的 `rdi=&BootInfo`，`REALLOC` 宏如何让物理地址跑的代码引用虚拟链接符号，换 CR3 同时如何换栈（UEFI 路径致命点），boot_info 如何躲过 BSS 清零。

---

## 1. 两条路径，一个汇合点

x86 上 Zonix 支持两种固件，它们把"找到内核、加载进内存、进入 64 位"这件事用完全不同的方式做完：

```
BIOS 路径（传统）:
  BIOS → MBR(512B, 16位) → VBR(512B, 16位, 懂 FAT32)
       → bootload.c(32位保护模式, ELF loader) → entry.S(32→64 long mode trampoline)
       → head.S
              ↘
UEFI 路径（现代）:                                  汇合点：head.S，rdi = &BootInfo
  固件 → BOOTX64.EFI(64位 PE32+, efi_main)         ↗
       → 用 Boot Services 读内核 ELF + 拿 framebuffer + 拿内存图 → ExitBootServices
       → head.S
```

BIOS 路径要自己一级级接力：MBR 只有 512 字节，只够把 VBR 读进来；VBR 懂一点 FAT32，把内核文件和更大的 bootloader 读进内存；bootloader 在 32 位保护模式下解析 ELF、加载段、清 BSS，再跳进 `entry.S` 的 long mode trampoline 切到 64 位。UEFI 路径则站在固件的肩膀上：固件已经在 64 位长模式，`BOOTX64.EFI` 直接用 Boot Services 读文件、拿 GOP framebuffer、拿内存映射，最后 `ExitBootServices()` 把机器交给我们。

**两条路径千差万别，但它们必须在 `head.S` 汇合时给内核交付完全相同的东西。** 这就是 `BootInfo` 协议的意义（[`6ff8a32`](https://github.com/leafvmaple/zonix-plus/commit/6ff8a32) 把两条路径统一进同一个 64 位入口）：

```cpp
struct BootInfo {
    uint32_t magic;              // 必须 == BOOT_INFO_MAGIC (0x12345678)，head.S 之后第一件事就是校验它
    uint32_t mem_lower, mem_upper;
    uint32_t mmap_length;        // 内存图条目数
    uint64_t mmap_addr;          // BootMemEntry 数组的物理地址（PMM 据此建空闲页池）
    uint32_t kernel_start, kernel_end, kernel_entry;
    uint8_t  boot_device;
    // framebuffer（UEFI 填 GOP，BIOS text 模式留空）
    uint64_t framebuffer_addr;
    uint32_t framebuffer_width, framebuffer_height, framebuffer_pitch;
    uint8_t  framebuffer_bpp, framebuffer_type;   // 0=text, 1=rgb
    char     loader_name[32];    // "Zonix BIOS" 或 "Zonix UEFI" —— 内核能打印出自己是被谁引导的
} __attribute__((packed));
```

`x86_64` System V ABI 约定第一个参数走 `rdi`，所以两条路径都把 `BootInfo*` 放进 `rdi` 再跳 `head.S`。内核侧 `kern_init(BootInfo* bi)` 的第一行就是：

```cpp
extern "C" [[noreturn]] int kern_init(struct BootInfo* boot_info) {
    if (!boot_info || boot_info->magic != BOOT_INFO_MAGIC)
        arch_halt();   // magic 不对 → 引导协议被破坏 → 立刻停机，别带病运行
    ...
}
```

> 这个 `magic` 不是装饰。引导期没有任何调试设施，如果 bootloader 和内核对 `BootInfo` 结构布局的理解错位了（比如改了字段顺序但只重编了一边），最先崩的地方往往离根因十万八千里。一个开头的 magic 校验，把"协议错配"这类最难查的 bug 变成一个**确定性的、就地停机的**失败。这和给网络包加 magic header 是同一个道理。

`__attribute__((packed))` 也是必须的——bootloader 那边可能是不同的编译目标（UEFI 用 `clang --target=x86_64-pc-windows-msvc`），两边对齐规则若不一致，结构体偏移就会错位。packed 强制按字节紧凑布局，消除编译器自由发挥的空间。

---

## 2. `REALLOC`：在物理地址上运行，却引用虚拟地址符号

`head.S` 一开始运行在**物理地址**（低地址，恒等映射），但它里面所有的符号（`__boot_pml4`、`__gdt`…）都是**按内核的虚拟地址（高半区 `0xFFFFFFFF80000000+`）链接**的。如果直接 `movq $__boot_pml4, %rdi`，拿到的是一个此刻还没映射的高地址，一访问就废。

解决办法是一个朴素到位的宏：

```asm
#define REALLOC(x) ((x) - KERNEL_BASE)   // 虚拟地址 - 高半区基址 = 对应的物理地址
```

因为内核被链接在 `KERNEL_BASE + 物理偏移`，所以"虚拟地址减去 `KERNEL_BASE`"恰好还原成物理地址。在还没建好高半区映射、还在低地址跑的这段窗口里，**所有符号引用都套一层 `REALLOC()`**：

```asm
movq $REALLOC(__boot_pml4), %rdi    # 用物理地址访问页表缓冲区
...
movq $REALLOC(__gdtdesc_phys), %rax
lgdt (%rax)                          # 用物理地址的 GDT 描述符
```

一旦页表建好、跳进高半区之后，符号就能用真正的虚拟地址了（`lgdt __gdtdesc(%rip)`，RIP-relative）。`REALLOC` 这层手术只在"物理地址运行 + 符号按虚拟链接"这段错位窗口里需要——它是引导汇编里最容易写错、调试最痛苦的一类问题（症状通常是访问到一片乱七八糟的内存），而一个明确的宏把这件事变成了一个肉眼可查的约定：**凡是带 `REALLOC` 的地方，就是还没进高半区的代码**。

> aarch64 的 `head.S` 用的是另一种等价方案：MMU OFF 阶段所有符号引用走 `adrp/adr`（PC 相对寻址），因为相对布局在物理/虚拟下是一致的，PC 相对就天然不受 VA/PA 偏移影响。两种架构、同一个问题（"代码运行地址 ≠ 链接地址"）、两种符合各自指令集习惯的解法——这正是 [#15 多架构抽象](https://github.com/leafvmaple/blog/issues/15) 想强调的：**有些东西就是没法抽象掉，只能每个架构各写一份，但要把它们隔离在 `arch/` 的最底层。**

---

## 3. 建页表 + 换 CR3 + 换栈：引导期最危险的三连

`head.S` 的核心是手工建出一套 4 级页表，做**两份映射**：

```asm
# 恒等映射:   0x0000_0000_0000_0000 → 0x0000_0000_3FFF_FFFF  (0..1GB，物理=虚拟)
# 高半区映射: 0xFFFF_FFFF_8000_0000 → 物理 0..1GB           (内核最终运行的地址)
```

为什么要**同时**有这两份？因为换页表（写 CR3）是一个原子瞬间：写之前 CPU 在用旧页表，写之后立刻用新页表。如果新页表里只有高半区映射，那么写完 CR3 的下一条指令——它的地址还在低地址（恒等区）——立刻就找不到映射了，当场缺页。所以新页表必须**既保留恒等映射（让"换页表那一刻正在执行的低地址代码"继续有效），又加上高半区映射（让内核能跳过去）**。换完 CR3、跳进高半区之后，再把恒等映射抹掉：

```asm
movq $REALLOC(__boot_pml4), %rax
movq %rax, %cr3              # 换页表：新旧都恒等映射低地址，所以这条指令的下一条还活着

# ... 重载 GDT、跳进高半区 _start64_high ...

_start64_high:
    movq $0, __boot_pml4(%rip)   # 现在在高半区跑了，可以安全抹掉恒等映射 PML4[0]
    movq %cr3, %rax
    movq %rax, %cr3              # 刷 TLB 让抹掉生效
```

但最隐蔽的一颗雷在**栈**。看这段注释和代码：

```asm
# 设一个临时栈在安全的低地址。
# 这对 UEFI 路径是生死攸关的：UEFI 固件的栈可能在 1GB 以上，
# 但我们的新页表只恒等映射了 0..1GB。换完 CR3 后，任何对高地址栈的访问
# 都会缺页。（BIOS 路径的 RSP 本来就是 0x7000，没这问题。）
movq $0x7000, %rsp          # ★ 换 CR3 之前，先把栈挪到低地址

movq $REALLOC(__boot_pml4), %rax
movq %rax, %cr3
```

这就是引导期最反直觉的一步：**换页表不只影响代码地址，也影响栈地址。** UEFI 固件交给我们时，RSP 可能指向固件分配的某个高地址栈。我们的新页表里那个高地址没映射——所以一旦 `mov %rax, %cr3` 执行完，下一次 `push`/`call`/`ret` 碰栈，就缺页死机。修复是在换 CR3 **之前**把 RSP 挪到 `0x7000`（一个一定被恒等映射覆盖的低地址）。BIOS 路径因为 bootloader 早就把栈设在低地址，碰巧躲过了这颗雷，所以这个 bug 只在 UEFI 路径暴露——又一个"换个引导路径就是一种 fuzzing"的例子（参见 [#12](https://github.com/leafvmaple/blog/issues/12) 里换编译器暴露 `switch_to` bug 的同构故事）。

凡是改变"地址 → 内容"映射的操作（换 CR3、换 TTBR、改 GDT、relocate），都要问一句：**此刻正踩着的每一块地（代码、栈、即将访问的数据）在新映射下还在不在**。引导期的绝大多数 triple fault 都是某块"脚下的地"在切换瞬间塌了。

跳进高半区、抹掉恒等映射之后，剩下的就平淡了：清 BSS（bootloader 只加载段、不负责清零未初始化数据）、设好真正的内核栈、`lidt` 装中断表、把保存好的 `BootInfo` 物理地址放进 `rdi`、`call kern_init`。控制权终于交给了 C++。

---

## 4. 一个工程细节：boot_info 必须躲过 BSS 清零

有个容易踩的小坑：内核启动早期要 `rep stosb` 清零 BSS 段，但 `BootInfo` 我们是从 bootloader 拷过来存在内核里的——如果它落在 BSS 里，就会被这次清零抹掉。`head.S` 把内核的 `BootInfo` 副本显式放进 `.data` 段而不是 BSS：

```asm
.section .data            # 注意：是 .data，不是 .bss
.align 8
__kernel_boot_info:
    .fill BOOT_INFO_SIZE, 1, 0
```

而且拷贝动作发生在清 BSS **之前**（`head.S` 一进来第一件事就是 `rep movsb` 把 bootloader 的 boot_info 搬进 `REALLOC(__kernel_boot_info)`）。`.data`（有初值、不被清零）和 `.bss`（无初值、启动时清零）的区别，平时写应用代码根本不用关心，但在内核引导这种"自己负责清自己 BSS"的场景里，放错段就是一个会让 framebuffer 地址、内存图全部归零的诡异 bug。

---

## 5. 迭代记录

<!-- 后续引导链的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-04-02：[`4d92e4f`](https://github.com/leafvmaple/zonix-plus/commit/4d92e4f) 整合 UEFI 引导流程并加入 riscv64 CI。
- 2026-03-30：[`45637c7`](https://github.com/leafvmaple/zonix-plus/commit/45637c7) 收敛 UEFI 引导辅助代码、移除 Bochs 支持，引导路径进一步统一；[`f006423`](https://github.com/leafvmaple/zonix-plus/commit/f006423) BIOS bootloader 从 C 迁到 C++。
- 2026-03-27：[`921ea7b`](https://github.com/leafvmaple/zonix-plus/commit/921ea7b) UEFI 入口从 C 迁到 C++，统一编码约定。
- 2026-03-24：[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166) UEFI 工具链从 MinGW GCC 换成 `clang --target=x86_64-pc-windows-msvc` + `lld-link`（详见 [#17](https://github.com/leafvmaple/blog/issues/17)）。
- 2026-02-12：[`501c4b8`](https://github.com/leafvmaple/zonix-plus/commit/501c4b8) 把 32→64 long mode 切换抽到 `entry.S` 并共享 bootlib（见 §1）。
- 2026-02-10：[`6ff8a32`](https://github.com/leafvmaple/zonix-plus/commit/6ff8a32) 把 BIOS / UEFI 统一进同一个 64 位 `head.S` 入口并引入 kernel config 系统。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
