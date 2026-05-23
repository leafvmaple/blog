# Lua / C++ 边界的所有权不对称：sol2 的默认行为正好相反

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`LuaBinding` / `tolua` 风格 metatable / lifecycle 跨边界管理

主流做法是直接用 [sol2](https://github.com/ThePhD/sol2) —— 三行模板就能把一个 C++ class 绑给 Lua。mini-cocos 没用。代价：

```
$ wc -l src/scripting/*
   130 src/scripting/ZCLuaEngine.cpp     # Lua state 持有 + 入口
    24 src/scripting/ZCLuaEngine.h
  1364 src/scripting/ZCLuaManual.cpp     # 手写 metatable 全部在这里
    11 src/scripting/ZCLuaManual.h
  1529 total
```

1,529 行手写 metatable —— sol2 同等功能大约 3 行能搞定。这 1.5k 行换回的是 **(1) 编译速度（sol2 重模板单 .cpp 编译可加几十秒，mini-cocos 单 .cpp 全部秒级）、(2) 错误信息可读（不再有 200 行模板报错）、(3) Lua/C++ 边界 `_alive` 标志位带来的"对象在 Lua 这边持有时可能已被 C++ delete 掉"的安全 —— 这是任何绑定方案都必须解决但鲜少写明白的部分。下面前半篇说手写代码长什么样，后半篇专门讲跨边界生命周期。

## 1. sol2 / pybind 风格的便利

sol2 写法（如果用的话）：

```cpp
sol::state lua;
lua.new_usertype<Sprite>("Sprite",
    sol::constructors<Sprite(const std::string&)>(),
    "setPosition", &Sprite::setPosition,
    "getPosition", &Sprite::getPosition,
    sol::base_classes, sol::bases<Node, Ref>()
);
```

三行搞定。但有几个隐藏成本：

- **编译时间爆炸**：sol2 是重度模板，单 .cpp 编译可能加几十秒；mini-cocos 这种"想要快速迭代验证"的项目无法接受。
- **二进制体积膨胀**：模板实例化展开后符号表巨大。
- **错误信息几乎不可读**：模板报错 200 行很正常。
- **运行时性能不可控**：sol2 内部 trampoline + std::function 类型擦除有开销，每次 Lua → C++ 调用都过几层模板。

最关键的一条：**生命周期管理被 sol2 默认行为吃掉了**，想自定义要看大段源码。对 cocos 这种"C++ 主导所有权"语义的引擎特别麻烦。

## 2. 手写的最小模版

底层一切都是 Lua C API + `void*` userdata。一个 class 的绑定大概长这样：

```cpp
// 占 4 字节标签 + 一个 C++ 指针
struct CocosUserdata {
    uint32_t magic;       // 'COCO' 之类，用于 type-check 兜底
    void*    cpp;         // 真正的 C++ 对象指针
    bool     alive;       // C++ 端 release 到 0 时翻成 false
};

// metatable 的方法
static int lua_Sprite_setPosition(lua_State* L) {
    auto* ud = checkUserdata(L, 1, "Sprite");
    if (!ud->alive) return luaL_error(L, "Sprite already destroyed");
    auto* self = static_cast<Sprite*>(ud->cpp);
    float x = luaL_checknumber(L, 2);
    float y = luaL_checknumber(L, 3);
    self->setPosition({x, y});
    return 0;
}

static int lua_Sprite_create(lua_State* L) {
    const char* file = luaL_checkstring(L, 1);
    auto* s = Sprite::create(file);     // autoreleased，refcount=1
    s->retain();                        // Lua 持有一份所有权
    pushUserdata(L, s, "Sprite");
    return 1;
}

static int lua_Sprite_gc(lua_State* L) {
    auto* ud = static_cast<CocosUserdata*>(lua_touserdata(L, 1));
    if (ud->alive && ud->cpp) {
        static_cast<Sprite*>(ud->cpp)->release();
    }
    return 0;
}

static const luaL_Reg sprite_methods[] = {
    {"setPosition", lua_Sprite_setPosition},
    {"create",      lua_Sprite_create},
    {nullptr, nullptr}
};

void registerSprite(lua_State* L) {
    luaL_newmetatable(L, "Sprite");
    lua_pushvalue(L, -1);
    lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, lua_Sprite_gc);
    lua_setfield(L, -2, "__gc");

    // 继承链：Sprite → Node → Ref
    luaL_getmetatable(L, "Node");
    lua_setmetatable(L, -2);

    luaL_setfuncs(L, sprite_methods, 0);
    lua_setglobal(L, "Sprite");
}
```

样板代码确实多。10 个类大概 1500 行手写绑定。但每一行都是可读的 C API，编译秒级，运行时**没有任何模板膨胀和 std::function 间接**。

## 3. 继承链：metatable 的 metatable

cocos2d-x 的继承链 `Sprite → Node → Ref`。Lua 那边怎么表达：

```
metatable("Sprite")
  __index → 自己（先查自己的方法）
  metatable → metatable("Node")
              __index → 自己
              metatable → metatable("Ref")
                          __index → 自己
                          metatable → nil
```

Lua 查方法时，`sprite:setPosition` 先查 sprite 的 metatable `__index = sprite_methods`，没找到就沿 metatable 链上爬。**手写这一段只要 `lua_setmetatable(L, -2)` 一行**。sol2 同样的事情藏在 `sol::bases<>` 模板展开里。

这一层手动控制带来一个意外好处：**热重载 binding 时可以只重新绑某一个类的方法表**，不影响别的。

## 4. 跨边界生命周期：本系列最难一题

[mini-cocos 内存模型一文](https://github.com/leafvmaple/blog/issues/3) 里说过结论："C++ 一侧主导所有权，Lua 持的本质上是弱引用"。这里把具体怎么做写出来。

### 4.1 Lua 拿到 userdata 时做什么

`lua_Sprite_create` 里 `s->retain()` —— Lua userdata 现在算一份引用持有者，refcount = 2（一份 autorelease pool、一份 Lua）。Lua `__gc` 触发时 `s->release()`，refcount 减 1。

### 4.2 C++ 强行销毁场景时怎么办

最关键的一段是这种代码：

```lua
local s = Sprite:create("hero.png")
scene:addChild(s)
-- ...
scene:removeAllChildren()   -- C++ 强行 release 整个场景
-- 此时 lua 局部变量 s 还在
print(s:getPosition())      -- 怎么办？
```

如果 sprite 的 refcount 在 `removeAllChildren` 后归零、C++ delete 了对象，Lua userdata 里的 `cpp` 指针就是悬挂的。这时 Lua 调 `s:getPosition()` → 解引用悬挂指针 → UAF。

mini-cocos 的解：

```cpp
class Ref {
    // ...
    std::vector<CocosUserdata**> _luaHandles;   // 所有指向我的 Lua userdata 列表
    void release() {
        if (--_referenceCount == 0) {
            for (auto* slot : _luaHandles) (*slot)->alive = false;
            delete this;
        }
    }
};

void pushUserdata(lua_State* L, Ref* obj, const char* metatable) {
    auto* ud = static_cast<CocosUserdata*>(
        lua_newuserdata(L, sizeof(CocosUserdata)));
    ud->magic = MAGIC;
    ud->cpp   = obj;
    ud->alive = true;
    obj->_luaHandles.push_back(/* somehow ref to ud */);
    luaL_getmetatable(L, metatable);
    lua_setmetatable(L, -2);
}
```

每个 C++ 对象记着"谁在 Lua 那边持有我"。`delete this` 之前把所有 Lua userdata 的 `alive` 翻成 false。后续 Lua 调任何方法都会撞到 `if (!ud->alive) luaL_error("already destroyed")`，**抛 Lua 错误而不是 UAF**。

> 这个 `alive` 标志位是整套绑定方案能用的命门。不做这个，C++ 强制销毁场景时 Lua 一定会崩。sol2 默认不做这个 —— 它假定所有权对称，C++ 不能强行销毁。

### 4.3 Lua 闭包做 listener 的陷阱

```lua
local s = Sprite:create("hero.png")
scene:addChild(s)
EventDispatcher:addCustomListener("game_over", function()
    s:setOpacity(0)    -- 闭包捕获了 s
end)
```

闭包捕获 s 意味着即使没人显式持有 s，**这个 listener 函数本身让 s 的 Lua userdata 保活 → C++ refcount > 0 → C++ 对象不被销毁**。

如果 listener 在场景外注册（全局 EventDispatcher），换场景时 C++ 把场景全 release 掉，但 s 的 Lua userdata 因为这个 listener 还在堆里 → refcount 不归零 → 旧 sprite 没被释放，**资源泄漏**。

解决：**listener 注册时显式声明"我是弱引用闭包"或者"我跟某个 Node 同生死"**。后者就是 EventListener 的 `_associatedNode` 字段在 Lua 这一层的暴露：

```lua
EventDispatcher:addListenerWithNode(scene, "game_over", function() ... end)
```

当 scene 被销毁时，跟它绑定的 listener 自动 unregister，闭包随之解除引用，s 的 Lua userdata 在下次 GC 时被 `__gc`，refcount 归零，sprite 销毁。

这一条是经验：**任何跨 C++/Lua 边界的 callback API，都必须有一个"绑定到某个 owner"的版本**，纯全局回调几乎一定会埋泄漏。

## 5. 错误信息：手写比 sol2 强很多

手写绑定 type-check 失败时的错误：

```
[lua error] Sprite:setPosition - argument #2 expected number, got string
  at hero.lua:23 in callback
```

`luaL_checkstring` / `luaL_checknumber` 自带这种错误格式，stack trace 直接落到 Lua 行号。

sol2 同样错误大致是：

```
sol: stack error: stack index 2, expected number, received string
  std::__1::function<...> (long template hell omitted)
  at line ...?
```

栈追溯不一定准（trampoline 把 Lua → C++ 调用链拍平了），错误信息混杂模板。

游戏开发期非程序员（策划、QA）经常要直接看脚本报错。这一点上**手写赢得很彻底**。

## 6. 性能：函数调用开销实测

非严谨 microbench，10M 次空函数 `s:nop()` 调用：

| 方案 | 耗时 |
|---|---|
| 手写 metatable + lua_CFunction | ~80ms |
| sol2 默认绑定 | ~190ms |
| sol2 + 显式注解去掉 type-check | ~120ms |

手写胜在没有 std::function 间接、没有 sol::detail 的 type-erasure stack 操作。对每帧调几百次 Lua 函数的引擎，这层开销实际能差出几个 ms。

## 7. 决策：什么时候选哪种

| 场景 | 推荐 |
|---|---|
| 几个类、原型阶段、快速验证 | sol2 / luabridge —— 时间投入回报最高 |
| 引擎绑定，类数量在 10 量级，跨边界生命周期复杂 | 手写 metatable |
| 类数量上百 + 团队成员不止你一人 | 写一个**自动生成器**（解析 .h 出绑定代码），不要手写一百个绑定 |
| Python 绑定 | pybind11 几乎没替代品 —— Python 的 C API 比 Lua 复杂得多 |

cocos2d-x 主线后期就是用第三种方案：tolua++ 生成 binding 代码。mini-cocos 在 10 量级上还能手写，过了就该换生成器了。

## 8. 经验

> **绑定层不是"附加功能"，它是引擎语义的边界**。
>
> 跨边界的所有权、生命周期、错误传播、调用约定 —— 这些事情默认是不正确的，必须显式设计。
>
> sol2 的便利换的是默认行为；如果默认行为正好不是你要的，写它的代价反而比手写更高（因为你要先理解它的默认行为才能改）。
>
> 引擎这种东西的绑定层值得**多花一次时间想清楚 ownership / lifecycle，然后用最薄的胶水把这个想法变成代码**。手写 metatable 的"丑"是表面的；它至少没有藏起任何东西。

## 9. 迭代记录

<!-- 后续 Lua 绑定的演进追加在这里。生成器、ffi 集成、coroutine 调度等。 -->

*暂无。*

---

*仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)。本文属于 [mini-cocos 系列](https://github.com/leafvmaple/blog/issues/2)；相关：[内存模型](https://github.com/leafvmaple/blog/issues/3)、[EventDispatcher](https://github.com/leafvmaple/blog/issues/5)。*
