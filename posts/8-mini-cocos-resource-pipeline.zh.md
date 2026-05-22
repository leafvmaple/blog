# 资源管线：FontAtlas 字形缓存与 FileUtils 搜索路径

> 仓库：[leafvmaple/mini-cocos](https://github.com/leafvmaple/mini-cocos)
> 系列：[mini-cocos 设计复盘 #2](https://github.com/leafvmaple/blog/issues/2) 的衍生深读
> 涉及子系统：`FontAtlas` / `Label` / `FileUtils` / `stb_truetype`

这一篇把两件看起来不相关、但都属于"资源管线"的东西合在一起：**字体绘制怎么不暴毙**（FontAtlas 增量光栅化），以及**怎么在多语言 + 多分辨率 + 玩家 mod 的情况下管理"加载一个文件"这件事**（FileUtils 搜索路径）。两者都属于"做对了透明、做错了到处崩"的基础设施。

## 1. 为什么 Label 是性能陷阱

最朴素的 Label 实现：

```cpp
void Label::setText(const std::string& s) {
    auto bitmap = rasterizeWholeText(s, _font, _fontSize);   // CPU 光栅化
    _texture = Texture::create(bitmap);                       // 上传 GPU
    _vertices = makeQuad(_texture->size());
}
```

这种写法在三件事上要命：

- **每次改 text 都重新光栅化整段** —— "score: 12345" 每帧变动一位数字，整段重画。
- **CJK 文本一次性把 6000+ 字符全光栅化** 一次几百 MB，加载界面卡死。
- **每个 Label 一张独立纹理**，state change 爆炸，渲染合批失效。

正确做法是 cocos2d-x 用的 FontAtlas：**字形按需光栅化、缓存到共享 atlas、Label 只生成 quad 的 UV**。

## 2. FontAtlas 的数据结构

```cpp
struct GlyphInfo {
    Rect uv;          // 在 atlas 上的位置
    Vec2 offset;      // bearing
    float advance;    // 推进宽度
};

class FontAtlas {
    TextureHandle _atlas;                          // 一张大纹理，默认 1024x1024
    std::unordered_map<char32_t, GlyphInfo> _glyphs;
    Vec2 _cursor = {0, 0};                         // 下一个字塞在哪里
    int  _rowHeight = 0;                           // 当前行的最高字形
    stbtt_fontinfo _fontInfo;
    float _scale;                                  // pixel / em
};
```

一个 FontAtlas 实例 = 一种 (font, size) 组合。`Label` 持有 atlas 的弱引用 + 自己生成的 `std::vector<Quad>`，不持有 texture。

### 2.1 增量光栅化

`getGlyph(char32_t cp)` 是核心 API：

```cpp
const GlyphInfo* FontAtlas::getGlyph(char32_t cp) {
    auto it = _glyphs.find(cp);
    if (it != _glyphs.end()) return &it->second;

    // 第一次见这个字：光栅化 + 塞 atlas
    int w, h, xoff, yoff;
    auto* bitmap = stbtt_GetCodepointBitmap(
        &_fontInfo, 0, _scale, cp, &w, &h, &xoff, &yoff);

    // 简单的 shelf packing
    if (_cursor.x + w > 1024) {
        _cursor.x = 0;
        _cursor.y += _rowHeight + 1;
        _rowHeight = 0;
    }
    if (_cursor.y + h > 1024) return nullptr;   // atlas 满，触发新 page

    uploadSubTexture(_atlas, _cursor.x, _cursor.y, w, h, bitmap);
    stbtt_FreeBitmap(bitmap, nullptr);

    GlyphInfo g{
        .uv = Rect(_cursor.x / 1024.0f, _cursor.y / 1024.0f, w / 1024.0f, h / 1024.0f),
        .offset = {static_cast<float>(xoff), static_cast<float>(yoff)},
        .advance = stbtt_GetCodepointAdvance(...) * _scale,
    };
    _cursor.x += w + 1;     // 1px gutter
    _rowHeight = std::max(_rowHeight, h);

    auto [iter, _] = _glyphs.emplace(cp, g);
    return &iter->second;
}
```

第一次出现的字付一次光栅化成本（< 1ms），后续每次都是 hashmap lookup。这是个**典型的 amortized 优化**：第一帧某段文字出现时可能掉帧一下，后续永远不再卡。

### 2.2 内存账

CJK 字体在不同策略下的 atlas 体积：

| 策略 | 字符数 | atlas 大小估算（16px 字号，每字 ~256 px²，含 1024² 包装） |
|---|---|---|
| 一次性预光栅化全 GB2312 | 6,763 | 至少 ~7MB（2-3 张 1024² 单通道纹理） |
| 一次性预光栅化常用 3500 | 3,500 | ~3.5MB |
| 按需光栅化（实际游戏出现） | 通常 < 800 | ~1MB |

按需光栅化在大部分游戏场景下省得**多得吓人** —— 玩家在主界面看到的字常常不超过 200 个 unique 字符。**预光栅化是新手最常做的过度优化**。

### 2.3 LRU 淘汰：要不要做？

atlas 满了之后两种处理：

- **新开一页 atlas**：内存上无封顶，但 fragmentation 不可控。
- **LRU 淘汰最久未访问的字形**：内存稳定，但被淘汰的字下次出现要重新光栅化 + 可能引发 atlas 重排，复杂。

mini-cocos 选了**新开页**。理由：

- 游戏运行期实际唯一字符数有上限（玩家不会在一局游戏里看到 100,000 个不同的字）。
- 切场景时整张 atlas 释放，自然回收。
- LRU 实现复杂度高、收益场景少。

如果是 chat-heavy 的社交游戏，可能要重新评估这个决策。

## 3. Label 的渲染：只生成 quad

```cpp
void Label::setText(const std::string& s) {
    _quads.clear();
    Vec2 pos = {0, 0};
    for (char32_t cp : utf8_decode(s)) {
        auto* g = _atlas->getGlyph(cp);
        if (!g) continue;
        _quads.push_back(makeQuad(pos + g->offset, g->uv));
        pos.x += g->advance;
    }
}
```

setText 现在的成本与字符串长度成正比，不再涉及 GPU 上传（除非碰到新字）。整段 text 共用一个 atlas texture → **同一种 (font, size) 的所有 Label 都能在一次 draw call 内 batch**。这是 FontAtlas 设计真正的产出。

## 4. FileUtils：搜索路径不是装饰

FileUtils 看起来就是个 `loadFile(path)` 封装，**但搜索路径机制让它真正变好用**。

```cpp
class FileUtils {
public:
    void addSearchPath(const std::string& path, int priority = 0);

    std::vector<uint8_t> load(const std::string& filename);
    std::string fullPath(const std::string& filename);
private:
    std::vector<std::pair<int, std::string>> _searchPaths;   // 按 priority 降序
    std::unordered_map<std::string, std::string> _resolveCache;
};
```

`load("hero.png")` 不需要知道 hero.png 在哪 —— 它依次试每个搜索路径，第一个找到的赢。这一条解决了三类需求：

### 4.1 多分辨率资源

```cpp
fu->addSearchPath("res/2x/", 10);
fu->addSearchPath("res/1x/", 0);
```

高分屏先试 2x、找不到回退 1x。代码里所有 `load("ui/button.png")` 不变。

### 4.2 多语言资源

```cpp
fu->addSearchPath("res/zh-CN/", 20);
fu->addSearchPath("res/en/",    10);
fu->addSearchPath("res/",       0);
```

中文环境先找 zh-CN/，没有的图就 fallback 到 en/（一般是默认资源）。运行时切语言 = 改 addSearchPath 优先级 + 清缓存。

### 4.3 玩家 mod / 热更包

```cpp
fu->addSearchPath("/sdcard/MyGame/mods/", 100);   // 玩家 mod 最高
fu->addSearchPath("appdata/hotpatch/",    50);    // 热更包
fu->addSearchPath("assets/",              0);     // 内置资源
```

mod / 热更只需要把覆盖的文件放进来就生效，**不需要改任何业务代码**。这是 cocos2d-x 的 FileUtils 真正"杀器"的一面。

### 4.4 全平台抽象的隐藏价值

`addSearchPath("assets/")` 在 Android 上指 APK 内的 assets/，在 iOS 上指 main bundle，在桌面平台指工作目录的 assets/。**业务代码完全不知道平台差异**。这是 cocos2d-x 在 2010 年代真正打开商用市场的基础设施之一。

mini-cocos 桌面版的实现简单粗暴：

```cpp
std::vector<uint8_t> FileUtils::load(const std::string& filename) {
    auto it = _resolveCache.find(filename);
    if (it != _resolveCache.end()) return readFile(it->second);

    for (auto& [prio, dir] : _searchPaths) {
        auto full = dir + filename;
        if (fileExists(full)) {
            _resolveCache[filename] = full;
            return readFile(full);
        }
    }
    return {};   // fail-fast：返回空，上层报错（不写 nullptr 分支）
}
```

Android port 在 fileExists/readFile 这一层多一个 `AAssetManager_open` 分支即可。**业务代码零修改**。

## 5. 两个细节决策

### 5.1 路径缓存的 invalidation

`_resolveCache` 命中加速明显，但 addSearchPath 之后要 clear，否则切语言不生效。

```cpp
void FileUtils::addSearchPath(const std::string& path, int priority) {
    _searchPaths.push_back({priority, path});
    std::sort(_searchPaths.begin(), _searchPaths.end(),
              [](auto& a, auto& b){ return a.first > b.first; });
    _resolveCache.clear();   // 必须
}
```

清缓存的代价就是切语言后下一次 load 慢一点。可以接受。

### 5.2 大小写敏感

Windows 不分大小写、Linux/Android 分。开发期 Windows 上 `load("UI/Button.png")` 正常，发到 Android 崩。处理方式：

- 在 Windows 桌面 debug build 里，找到文件后**比对实际文件名大小写**，不匹配就 warning。这样开发期能立刻发现。
- 不做隐式 lowercase 兜底 —— 那会埋藏更难发现的 bug。

这是 fail-fast 风格：**在能崩的地方就让它崩**，不要写"看起来贴心"的兜底。

## 6. 没做的事 + 留口

- **资源依赖图**：plist 引用 texture，scene 引用 plist 这一类。mini-cocos 没显式管理，靠人记。规模上来需要补。
- **异步加载**：所有 load 都是同步的。`std::async` 包一层就行，但要重新审视 cache 的线程安全。
- **磁盘缓存的压缩 / 加密**：未做，留 hook 点在 readFile 这一层。

## 7. 经验

> **资源管线的设计标准就一条："业务代码能不能跟资源解耦"。**
>
> Label 不知道字怎么光栅化的、texture 怎么上传的 → 文字渲染解耦。
> 业务代码不知道文件在哪个目录、哪个语言、哪个 mod → 资源加载解耦。
>
> 一旦做到这一条，**多分辨率、多语言、mod、热更全部是 ops 配置而不是代码修改**。这是 cocos2d-x 在国内手游浪潮中真正的护城河。

## 8. 迭代记录

<!-- 后续资源管线的演进追加在这里。异步加载、依赖图、压缩等。 -->

- 2026-05-22：[`fc43261`](https://github.com/leafvmaple/mini-cocos/commit/fc43261) Label + Lua/UI binding 的零碎清理（Label 头里删掉两处用不到的 friend、UIButton 跟着 Label 字号 API 改名做了同步）。
- 2026-05-22：[`155f650`](https://github.com/leafvmaple/mini-cocos/commit/155f650) 新增 `FontAtlasCache` —— 在 `FontAtlas` 之上做"(face + 字号)" key 复用。从前同一种 ttf 不同字号会各开一份 atlas，加上半透明 UI 多种字号的常见配置，atlas page 数能爆到 8+；加了 cache 之后退化到 2~3 个。FontAtlasCache 同时是 Renderer 跨 Label 批合并能成立的前提（同字体同字号的两个 Label 共用 atlas page，cmd 才能合并）。配套地 Label 重写为"按 page 分桶 emit"，详见 [#6 渲染层迭代记录](https://github.com/leafvmaple/blog/issues/6)。
- 2026-05-22：[`6e06290`](https://github.com/leafvmaple/mini-cocos/commit/6e06290) + [`1e8f941`](https://github.com/leafvmaple/mini-cocos/commit/1e8f941) Label 和 FontAtlas 结构重排向 cocos2d-x 原版靠齐 —— 把原本写在 Label 里的字符布局推回 FontAtlas（让"我有哪些字、它们的 advance/uv 是什么"集中在一处），Label 这边只剩"按 atlas 的查询结果生成顶点"。这一刀让后续"换字体""换 shader""做富文本"全部成本下降一个量级。

---

*本文是 [mini-cocos 设计复盘](https://github.com/leafvmaple/blog/issues/2) 系列的衍生深读。*
