<!--pub:2026-04-12-->
# freestanding 不等于退回 C：内核里照样跑 RAII 和 `Result<T>`

> 仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)
> 系列：[Zonix OS 设计复盘 #11](https://github.com/leafvmaple/blog/issues/11) 的衍生深读
> 涉及子系统：`kernel/cxxrt.cpp` / `kernel/init.cpp` / `lib/result.h` / `lib/memory.h` / 工具链

Zonix 整个内核是 C++17 freestanding —— `-ffreestanding -fno-exceptions -fno-rtti -nostdinc -nostdinc++`，没有 libc、没有 STL、没有异常、没有 RTTI，但模板、RAII、`constexpr`、`[[nodiscard]]`、命名空间一个没少。把缺的运行时支撑补出来的代价仅 `kernel/cxxrt.cpp` 94 行：6 个 C 函数（`memset` / `memcpy` / `memmove` / `memcmp` / `__cxa_pure_virtual` / `atexit`）+ 8 个 `operator new`/`delete` 重载。这一篇讲为什么这 94 行就足够 —— 以及为什么这些零开销抽象在内核里比在应用层更值。

---

## 1. freestanding 到底缺了什么

`-ffreestanding` 告诉编译器"目标环境没有标准库托管"。具体缺的是：

- **没有 `std::`**：没有 `std::vector`、`std::string`、`std::unordered_map`。容器要自己写（Zonix 有 `Array<T,N>`、侵入式 `ListNode`）。
- **没有 `operator new`/`delete` 的默认实现**：`new Foo` 这个表达式编译器认，但它生成的对 `operator new` 的调用没人提供——链接期 undefined reference。
- **没有异常和 RTTI**：`-fno-exceptions -fno-rtti`。没有栈展开（unwinding）运行时，`throw` 无处可去；没有 `dynamic_cast`/`typeid`。
- **没有全局构造的自动调用**：`static SchedulerPolicy policy;` 这种带构造函数的全局对象，它的构造函数**不会自动跑**——hosted 环境是 C 运行时（crt0）帮你跑的，freestanding 里没有 crt0。
- **没有 `memcpy`/`memset` 这些 C 库函数**——可偏偏编译器会**自己生成对它们的调用**（结构体赋值、数组清零时）。

后面三条是最隐蔽的坑：它们不是"你想用但没有"，而是"**编译器假定它们存在并替你插了调用，但其实没人实现**"。补齐这几样，是让 C++ 在内核里"活过来"的关键。

---

## 2. 补运行时（一）：全局 `new`/`delete` 接到 kmalloc

`kernel/cxxrt.cpp` 把 `operator new`/`delete` 全套实现接到内核堆 `kmalloc`/`kfree` 上：

```cpp
void* operator new(__SIZE_TYPE__ size, const std::nothrow_t&) noexcept { return kmalloc(size); }
void* operator new(__SIZE_TYPE__ size)                                 { return operator new(size, std::nothrow); }
void* operator new[](__SIZE_TYPE__ size)                               { return operator new[](size, std::nothrow); }

void  operator delete(void* p) noexcept              { kfree(p); }
void  operator delete(void* p, __SIZE_TYPE__) noexcept { kfree(p); }   // C++14 sized delete
void  operator delete[](void* p) noexcept            { kfree(p); }
```

几个细节：

- **普通 `new` 转发到 nothrow 版**。hosted 环境里 `new` 失败抛 `std::bad_alloc`，但我们 `-fno-exceptions`，抛不了。所以让普通 `new` 直接走 nothrow 路径，失败返回 `nullptr`，由调用方检查（内核里到处是 `if (!p) return Error::NoMem;`，配合 [#11](https://github.com/leafvmaple/blog/issues/11) 的 `Result<T>`）。
- **sized delete**（`operator delete(void*, size_t)`）必须提供。C++14 起编译器可能生成带 size 的 delete 调用，少一个就是链接错误。
- **它们必须是 non-inline，定义在 `.cpp` 里。** 这是一条被工具链迁移逼出来的经验——Clang 的 `-Winline-new-delete` 会对 inline 的 `new`/`delete` 报警。最初这几个定义放在 `memory.h` 头文件里（隐式 inline），换 Clang 后立刻报警，于是搬进 `cxxrt.cpp` 成为唯一的 non-inline 定义。

接上之后，内核里就能正常 `new TaskStruct()`、`delete proc`，`Result<T>`、`LockGuard<T>` 这些模板该 new 的 new、该 delete 的 delete，和 hosted C++ 写起来几乎没差别。

---

## 3. 补运行时（二）：编译器偷偷需要的 `memcpy` 与纯虚桩

即使 `-fno-builtin`，Clang 仍可能为结构体赋值、数组初始化生成对 `memset`/`memcpy` 的调用，并期望链接到这些符号。还有 `__cxa_pure_virtual`（纯虚函数被调用时的兜底）、`atexit`（注册全局析构）。这些都得自己提供：

```cpp
extern "C" {
void* memset(void* s, int c, size_t n) { return arch_memset(s, c, n); }   // 转给架构最优实现
void* memcpy(void* d, const void* s, size_t n) { return arch_memcpy(d, s, n); }
void* memmove(void* d, const void* s, size_t n) { /* 处理重叠 */ }
int   memcmp(const void*, const void*, size_t);

void __cxa_pure_virtual() { arch_halt_forever(); }   // 纯虚被调 = 严重 bug，挂住让它可见
int  atexit(void (*)()) { return 0; }                // 内核永不退出 → 全局析构永不跑 → 空实现
}
```

`memset`/`memcpy` 转发到 [#15](https://github.com/leafvmaple/blog/issues/15) 讲过的架构最优 `arch_memset`/`arch_memcpy`（x86 上是 `rep stosq`/`rep movsq`）。`atexit` 直接返回 0——内核启动后永不返回，全局对象的析构函数永远不会运行，所以注册它们纯属浪费，空实现最诚实。`__cxa_pure_virtual` 挂死而不是静默——纯虚函数被调到说明对象在构造/析构期被错误地多态调用了，这是必须暴露的 bug。

> 这一节的元经验是：**freestanding 不是"少用点 C++ 特性"，而是"把宿主环境替你做的那点运行时支撑，自己显式做一遍"。** 一旦这薄薄一层 `cxxrt` 补齐，上面就能跑完整的 C++ 对象模型——这正是"自己承担每一个抽象的实现成本"的训练。

---

## 4. 补运行时（三）：手动跑 `.init_array` 全局构造链

带构造函数的全局对象（比如调度器策略 `static SchedulerPolicy policy;`），编译器把它们的构造函数指针收集到一个叫 `.init_array` 的 section。hosted 环境由 crt0 遍历这个 section 跑构造；freestanding 里**必须自己跑**：

```cpp
extern "C" {
using ctor_func = void (*)();
extern ctor_func __init_array_start[];    // 链接脚本提供的边界符号
extern ctor_func __init_array_end[];
}

static void cxx_init() {
    for (auto* fn = __init_array_start; fn < __init_array_end; fn++)
        (*fn)();                           // 逐个调用全局构造函数
}

extern "C" [[noreturn]] int kern_init(struct BootInfo* bi) {
    if (!bi || bi->magic != BOOT_INFO_MAGIC) arch_halt();
    cxx_init();                            // ★ 必须在用到任何全局对象之前调
    cons::init();
    run_steps(KERN_STEPS, ...);            // 然后才是 [#11] 讲的表驱动初始化
    ...
}
```

`cxx_init()` 必须排在 `kern_init` 开头、任何全局对象被使用之前。漏了它，所有带构造函数的全局对象都是**未构造的随机内存**，症状千奇百怪且极难定位（因为代码看起来完全正常，只是对象的字段是垃圾值）。这是 freestanding C++ 最容易被忘的一步——你享受了"全局对象能带构造函数"的便利，就得自己负责让那些构造函数真的跑起来。

---

## 5. 现代错误处理：为什么不是异常，而是 `Result<T>`

freestanding 没有异常（栈展开运行时不存在），但内核恰恰最需要严密的错误传播——一个被忽略的错误码可能就是一次 silent 数据损坏。Zonix 的答案是 `Result<T>` + `TRY` 宏（[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa)，[#11 §3](https://github.com/leafvmaple/blog/issues/11) 已概览，这里讲机制）：

```cpp
template<typename T>
class [[nodiscard]] Result {       // [[nodiscard]]：忽略返回值 → 编译警告
    T val_{}; Error err_{Error::None}; bool ok_{false};
public:
    Result(const T& v) : val_(v), ok_(true) {}   // 成功：从 T 隐式构造
    Result(Error e)    : err_(e) {}               // 失败：从 Error 隐式构造
    bool ok() const; T& value(); Error error() const;
    T release_value(); Error release_error();
};

template<> class [[nodiscard]] Result<void> {     // Result<void> 特化：只传播成败，不带值
    Error err_{Error::None};
public:
    Result() {} Result(Error e) : err_(e) {}
    bool ok() const { return err_ == Error::None; }
};
```

`TRY` 宏用 GCC/Clang 的**语句表达式**（statement expression，`({ ... })` 能求值的语句块）实现类 Rust `?` 的早返回：

```cpp
#define TRY(expr) __extension__({                       \
    auto _r = ::detail::wrap_tryable(expr);             \
    if (!_r.ok()) [[unlikely]] return _r.release_error();   \
    _r.release_value();                                 \
})
```

`wrap_tryable` 用重载让 `TRY` **既吃 `Result<T>`**（解包出 `T`）**又吃裸 `Error`**（包装成一个无值的 `ErrorResult`，纯做传播）：

```cpp
inline ErrorResult wrap_tryable(Error e);            // 裸 Error → 可 TRY 的包装
template<typename T> Result<T> wrap_tryable(Result<T> r);   // Result<T> 原样

auto fd   = TRY(files.alloc(file));   // alloc 返回 Result<int>，出错则 return，成功拿到 int
TRY(swap_device->read(sector, kva, n)); // read 返回 Error，出错则 return，成功无值
```

配套还有 `TRY_LOG`（传播前先打一行日志）、`ENSURE(cond, err)`（条件不满足就返回错误，类似断言但不崩溃）。`ENSURE` 后来还做了**变参重载**（[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896)）——靠 `_ENSURE_SELECT(_1, _2, NAME, ...)` 这个经典的"按参数个数分发"宏技巧，让 `ENSURE(cond)` 默认返回 `Error::Invalid`、`ENSURE(cond, err)` 保留指定错误码：

```cpp
#define _ENSURE1(cond)      do { if (!(cond)) [[unlikely]] return Error::Invalid; } while (0)
#define _ENSURE2(cond, err) do { if (!(cond)) [[unlikely]] return (err);          } while (0)
#define _ENSURE_SELECT(_1, _2, NAME, ...) NAME
#define ENSURE(...) _ENSURE_SELECT(__VA_ARGS__, _ENSURE2, _ENSURE1)(__VA_ARGS__)
```

于是绝大多数"参数非法就返回 Invalid"的检查可以省到只写 `ENSURE(ptr)`，少数需要特定错误码的写 `ENSURE(cond, Error::NoMem)`——`exec`/FAT 驱动一轮（[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b)）就靠它把大量 `if (!x) return ...` 折叠成了单行。整套机制都是**纯编译期 + 零运行期开销**——没有异常表、没有栈展开，展开后就是几条 `if + return`，但写起来有了类似异常的"出错自动冒泡"体验，又比异常更显式、更可控。

> 立场：**异常在 freestanding 内核里既不可用（没运行时）也不该用（不可预测的展开路径、隐藏的控制流）。** 但"不用异常"不等于"退回 C 的 `if (ret < 0) goto fail`"。`Result<T>` + `TRY` 用模板和宏，在零开销的前提下拿回了类型安全（`[[nodiscard]]` 逼你检查）和组合性（`TRY` 链式传播）。这是 freestanding 环境里"现代 C++ 收益最大、成本最低"的一块。

---

## 6. 工具链：从 GCC/GNU ld 整体迁到 Clang/LLD/LLVM (`9fae90c`)

`9fae90c` 把内核、arch 代码、BIOS boot 的编译链从 `gcc`/`g++`/`ld`/`objcopy` 整体换成 `clang`/`clang++`/`ld.lld`/`llvm-objcopy`。UEFI bootloader 更进一步（[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166)），从 MinGW GCC 交叉编译换成 `clang --target=x86_64-pc-windows-msvc` + `lld-link`——**同一个 Clang 既能编 ELF 内核、又能编 PE32+ 的 UEFI 应用**，靠的就是换个 `--target`，不再需要装一整套 MinGW 工具链。

这次迁移的真正价值不在"换个编译器"，在它**像一次免费的代码审计，把一批潜伏的问题一次性抖了出来**：

- **`switch_to` 的 RSP off-by-8**：GCC 的 `leave;ret` epilogue 掩盖了几个月的栈 bug，被 Clang 的 RSP-relative epilogue 当场暴露成 triple fault。这是整个项目最戏剧性的一个 bug，我在 [#12 §2](https://github.com/leafvmaple/blog/issues/12) 完整讲了它。
- **`-Winline-new-delete`**：Clang 不喜欢 inline 的 `new`/`delete`，逼我把它们从头文件搬进 `cxxrt.cpp`（见 §2）。
- **符号比较警告、RWX segment 警告、缺失的 `.note.GNU-stack`**：一串 GCC 默默放过、Clang/LLD 较真的小问题（[`b69882e`](https://github.com/leafvmaple/zonix-plus/commit/b69882e) 一轮清零所有警告）。

换一套编译器是一种几乎免费的 fuzzing。不同编译器对"未定义/未指定行为"会做出完全不同但都合法的选择 —— "在 GCC 下恰好能跑"的代码本质上依赖了一组没写进标准的隐性假设，换 Clang 等于让另一组合法假设重新审视一遍全部代码。它发现的每一个，都是真实存在、迟早会爆的隐患。

最后一条相关的演进是 [`2e809ca`](https://github.com/leafvmaple/zonix-plus/commit/2e809ca)：把一批宏替换成 `inline constexpr`/`inline` 函数。`#define PAGE_SIZE 4096` 换成 `inline constexpr size_t PAGE_SIZE = 4096;`，宏函数换成 inline 函数——拿回类型检查、作用域、调试器可见性，同时零运行期开销。这又是"freestanding 不必退回预处理器时代"的一个注脚：现代 C++ 的零开销抽象，在内核里能用、且更该用。

---

## 7. 迭代记录

<!-- 后续 C++ runtime / 工具链的演进追加在这里，按时间倒序。每条带 commit 链接 + 一两句说明。 -->

- 2026-05-22：[`dd6ccee`](https://github.com/leafvmaple/zonix-plus/commit/dd6ccee) 把 ELF 校验封装进 `ElfHdr::is_valid()`/`is_executable()` 成员函数 —— "freestanding 里照样用现代 C++"的延续（关联 [#18](https://github.com/leafvmaple/blog/issues/18)）。
- 2026-04-08：[`56af896`](https://github.com/leafvmaple/zonix-plus/commit/56af896) 给 `ENSURE` 加变参重载（单参默认 `Error::Invalid`，见 §5）；[`295581b`](https://github.com/leafvmaple/zonix-plus/commit/295581b) 用它批量简化 `exec`/FAT 的错误处理；[`5f15c72`](https://github.com/leafvmaple/zonix-plus/commit/5f15c72) 给一批布尔访问器加 `[[nodiscard]]`。
- 2026-04-07：[`ff916fa`](https://github.com/leafvmaple/zonix-plus/commit/ff916fa) 引入 `Result<T>` + `Error` + `TRY`/`ENSURE` 宏，[`b1ea334`](https://github.com/leafvmaple/zonix-plus/commit/b1ea334) 把全内核 `int` 返回码迁移过去（见 §5）。
- 2026-03-24：[`1437166`](https://github.com/leafvmaple/zonix-plus/commit/1437166) UEFI 改用 `clang --target=x86_64-pc-windows-msvc`。
- 2026-03-12：[`9fae90c`](https://github.com/leafvmaple/zonix-plus/commit/9fae90c) 工具链整体迁移到 Clang/LLD/LLVM 并暴露 `switch_to` bug（见 §6 / [#12](https://github.com/leafvmaple/blog/issues/12)）；新增 `cxxrt.cpp` 收纳运行时桩 + non-inline 的 `new`/`delete`（见 §2/§3）。
- 2026-03-11：[`2e809ca`](https://github.com/leafvmaple/zonix-plus/commit/2e809ca) 用 `inline constexpr`/inline 函数替换宏，并补架构最优 memops（见 §6）。
- 2026-03-05：[`b69882e`](https://github.com/leafvmaple/zonix-plus/commit/b69882e) v0.9.0 一轮清零所有编译/链接警告（见 §6）。
- 2026-03-04：[`7138771`](https://github.com/leafvmaple/zonix-plus/commit/7138771) 把各子系统封进命名空间、把 kernel 基础库归位到 `lib/`。

---

*仓库：[leafvmaple/zonix-plus](https://github.com/leafvmaple/zonix-plus)。本文属于 [Zonix OS 系列](https://github.com/leafvmaple/blog/issues/11)。*
