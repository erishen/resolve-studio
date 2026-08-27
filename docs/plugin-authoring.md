# 插件开发指南 — resolve-studio

> 本文档说明如何为 resolve-studio 编写 Cordis 插件。从最简单的「hello world」到带服务、工具、事件、生命周期的完整插件，逐步覆盖所有模式。

---

## 1. 核心概念

resolve-studio 的运行时基于 [Cordis 4](https://cordis.xiaoyaoji.cn/) 的依赖注入容器。一切功能——LLM 后端、工具、Agent 循环、前端、技能——都是 **插件** 或 **服务**，由 `cordis.yml` 配置驱动装配。

两种形态：

- **Service 类插件**：继承 `Service`，挂在 `ctx` 上（如 `ctx.systemInfo`），提供可被其他插件注入的 API。有生命周期（`start`/`stop`），可发射事件。
- **函数插件**：一个接收 `(ctx, options)` 的函数，通常用来注册工具到 `ctx.tools`。无生命周期，加载即执行。

一个包可以同时导出两种形态（如 `plugin-system-info` 既导出 `SystemInfoService`，也导出 `toolSystemInfo` 工具函数）。

---

## 2. 最小插件骨架

### 2.1 目录结构

```
packages/plugin-<name>/
├── src/
│   └── index.ts        # 插件入口
├── package.json
└── tsconfig.json
```

### 2.2 `package.json`

```json
{
  "name": "@resolve-studio/plugin-<name>",
  "version": "0.1.0",
  "description": "First-party Cordis plugin for resolve-studio (<name>)",
  "type": "module",
  "license": "MIT",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "cordis": "^4.0.0-rc.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0",
    "tsx": "^4.20.0"
  }
}
```

**关键约束**：`dependencies` 里只能有 `cordis`（纯 Cordis 契约）。不能引入 `@resolve-studio/core`——否则就失去了跨生态可移植性。

### 2.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

**必须**用 `module: ESNext` + `moduleResolution: Bundler`。改用 `NodeNext` 会导致 Cordis 的子路径导出解析失败。

### 2.4 `src/index.ts` — Service 类插件

```ts
import { Context, Service } from 'cordis'

// 1. 类型增强：告诉 Cordis ctx 上多了什么
declare module 'cordis' {
  interface Context {
    myPlugin: MyPluginService
  }
}

// 2. 配置接口
export interface MyPluginOptions {
  greeting?: string
}

// 3. Service 类
export class MyPluginService extends Service {
  private readonly greeting: string

  constructor(ctx: Context, options: MyPluginOptions = {}) {
    super(ctx, 'myPlugin')
    this.greeting = options.greeting ?? 'hello from my-plugin'
  }

  /** 其他插件可通过 ctx.myPlugin.ping() 调用 */
  ping(): string {
    this.ctx.logger('my-plugin').info(this.greeting)
    return this.greeting
  }

  /** 生命周期：插件加载后自动调用 */
  protected start() {
    this.ctx.logger('my-plugin').info('service started')
  }

  /** 生命周期：进程退出前自动调用 */
  protected stop() {
    this.ctx.logger('my-plugin').info('service stopped')
  }
}

// 4. 默认导出：插件入口函数
export default (ctx: Context, options: MyPluginOptions = {}) => {
  ctx.plugin(MyPluginService, options)
}
```

---

## 3. 注册工具（让 LLM 能调用）

Service 类插件对 UI 不可见——它活在运行时里，其他插件可以注入调用，但模型看不到。要让模型能调用，需要注册一个 **工具** 到 `ctx.tools`。

### 3.1 工具函数插件

```ts
import type { Context } from 'cordis'

// 因为不能 import core 的类型（纯 Cordis 契约），用 interface 声明需要的形状
interface ToolRegistryLike {
  register(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(args: Record<string, unknown>): Promise<string>
  }): void
}

const registerMyTool = (ctx: Context) => {
  const tools = (ctx as unknown as { tools: ToolRegistryLike }).tools
  if (!tools) return

  tools.register({
    name: 'my-tool',
    description:
      'Does something useful. The model reads this description to decide when to call it.',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'What to process',
        },
      },
    },
    async execute(args) {
      const input = args['input'] as string
      return `processed: ${input}`
    },
  })
}

// 辅助函数：给插件加 name 和 inject 元数据
function definePlugin<T extends object>(target: T, name: string, inject?: string[]): T {
  Object.defineProperty(target, 'name', { value: name, writable: true, configurable: true })
  if (inject) {
    const obj: Record<string, unknown> = {}
    for (const k of inject) obj[k] = {}
    ;(target as { inject?: unknown }).inject = obj
  }
  return target
}

export const toolMyPlugin = definePlugin(registerMyTool, 'tool-my-plugin', ['tools'])
```

### 3.2 两层模式

resolve-studio 遵循「两层模式」：

1. **Service 层**（`ctx.myPlugin`）：运行时原语，其他插件可注入调用。
2. **Tool 层**（`ctx.tools.register`）：把 Service 的能力暴露给 LLM，出现在 UI 工具列表里。

这样设计的好处：Service 可以独立于 UI 存在，被其他 Service 直接调用（无需经过 Agent 循环），同时也能按需暴露给模型。

---

## 4. 事件系统

Cordis 的 `ctx.events` 是解耦的发布-订阅总线。插件可以发射自定义事件，前端（CLI/Web）或其他插件可以监听。

### 4.1 声明事件类型

```ts
declare module 'cordis' {
  interface Events {
    'my-plugin/data'(payload: { value: number }): void
  }
}
```

### 4.2 发射事件

```ts
this.ctx.events.emit('my-plugin/data', { value: 42 })
```

### 4.3 监听事件

```ts
const dispose = ctx.events.on('my-plugin/data', (payload) => {
  console.log('received:', payload.value)
})
// dispose() 取消监听
```

**注意**：Cordis 的 `events.on` 返回一个 disposer 函数，调用它来取消监听。没有 `off` 方法。

---

## 5. 跨服务注入

Cordis 4 要求**显式声明**跨服务依赖。漏掉 `inject` 声明会导致运行时抛 `cannot get property "xxx" without inject`。

### 5.1 Service 类

```ts
export class MyService extends Service {
  static inject = { tools: {}, llm: {} } // 声明依赖 ctx.tools 和 ctx.llm

  constructor(ctx: Context) {
    super(ctx, 'myService')
  }

  doSomething() {
    // 现在可以安全访问 this.ctx.tools 和 this.ctx.llm
    const schemas = this.ctx.tools.schemas()
  }
}
```

### 5.2 函数插件

```ts
const registerMyTool = (ctx: Context) => {
  // ...
}

// 第三个参数声明 inject
export const toolMyPlugin = definePlugin(registerMyTool, 'tool-my-plugin', ['tools', 'llm'])
```

---

## 6. 接入项目管线

写好插件后，需要把它接入 monorepo 的装配流程。

### 6.1 添加到 core 依赖

`packages/core/package.json`：

```json
{
  "dependencies": {
    "@resolve-studio/plugin-<name>": "workspace:*"
  }
}
```

`workspace:*` 是必须的——loader 通过动态 `import()` 解析包名，pnpm 需要知道这是 workspace 内的包。

### 6.2 注册到 PLUGINS（工具插件）

如果是**工具函数插件**（注册到 `ctx.tools` 的），需要在 `packages/core/src/plugins/registry.ts` 的 `PLUGINS` 表里登记：

```ts
import { toolMyPlugin } from '@resolve-studio/plugin-<name>'

export const PLUGINS: Record<string, Plugin> = {
  // ...
  'tool-my-plugin': toolMyPlugin as unknown as Plugin,
}
```

**Service 类插件不需要在这里注册**——它通过包名在 `cordis.yml` 里直接加载（见下一步）。

### 6.3 加入配置清单

`scripts/gen-manifests.mjs` 是四份 `cordis*.yml` 的唯一真相源。

```js
const BASE_PLUGINS = [
  // ...
  // Service 类插件：用包名加载（动态 import）
  { id: 'my-plugin', name: '@resolve-studio/plugin-<name>', config: { greeting: 'hi' } },
  // 工具函数插件：用短名加载（从 PLUGINS 表解析）
  { id: 'tool-my-plugin', name: 'tool-my-plugin' },
]
```

然后运行：

```bash
node scripts/gen-manifests.mjs   # 或 make manifests
```

这会重新生成 `cordis.yml` / `cordis.openai.yml` / `cordis.web.yml` / `cordis.openai.web.yml`。

### 6.4 安装依赖 & 验证

```bash
pnpm install                              # 链接 workspace 包
pnpm -C packages/plugin-<name> typecheck  # 类型检查
pnpm -C packages/core run check           # 核心 typecheck + 测试
```

---

## 7. 脚手架命令

快速生成一个新插件包：

```bash
node scripts/new-plugin.mjs weather
# → 创建 packages/plugin-weather/
# → 添加 @resolve-studio/plugin-weather 到 core dependencies
# → 追加条目到 cordis.patch.yml
```

然后 `pnpm install` 即可。生成的是最小骨架，按需扩展。

---

## 8. 配置格式

### 8.1 `cordis.yml`（flat 格式）

```yaml
plugins:
  - id: my-plugin
    name: '@resolve-studio/plugin-<name>'
    config:
      greeting: 'hello world'
      interval: 30000
```

### 8.2 `cordis.patch.yml`（dsh 兼容格式）

```yaml
- insert:
    - id: my-plugin
      name: '@resolve-studio/plugin-<name>'
      config:
        greeting: 'hello world'
```

两种格式都被 loader 接受。`name` 可以是本地短名（从 `PLUGINS` 表解析）或 npm 包名（动态 `import()`）。

---

## 9. 常见陷阱

### 9.1 `name` 只读

tsx/esbuild 的 `__name` helper 把 class/function 的 `name` 标为只读。Cordis 用 `Object.assign(plugin, { name })` 注入元数据时会抛 `Cannot assign to read only property 'name'`。

**解决**：用 `definePlugin` 包装，它用 `Object.defineProperty(..., { writable: true })` 绕过。

### 9.2 `inject` 形状

Cordis 4 内部把 `inject` 存为对象（`{ agent: {} }`）。传 `string[]` 会让 `Object.entries` 把数组下标当服务名。

**解决**：`definePlugin` 的 `normalizeInject` 会自动把数组转为对象形式。

### 9.3 跨服务访问必须声明 `inject`

漏掉 `static inject = { ... }`（Service 类）或 `definePlugin(fn, name, ['tools'])`（函数插件）的 inject 声明，访问 `ctx.<service>` 时会抛 `cannot get property "xxx" without inject`。

### 9.4 外部包不能重复声明 `ctx.tools`

如果一个外部插件（只依赖 `cordis`）在 `declare module 'cordis'` 里重新声明 `ctx.tools`，会与 core 的声明冲突（TS2687）。

**解决**：用类型断言 `(ctx as unknown as { tools: ToolRegistryLike }).tools` 访问，不重复声明。

### 9.5 tsconfig 必须用 `module: ESNext` + `moduleResolution: Bundler`

改用 `NodeNext` 时 Cordis 的 `exports` 未暴露 `./context` 子路径，TS 无法解析 `Context` 的 class 实现。

### 9.6 关闭 `declaration`

Cordis `Service` 用了私有 symbol 属性，导出 `.d.ts` 会报 `cannot be named`。运行期用 tsx 直接跑 `.ts`，无需声明文件。所以 `tsconfig.json` 里设 `"noEmit": true`。

---

## 10. 完整示例：plugin-system-info

`packages/plugin-system-info` 是一个功能完整的插件，展示了所有模式：

- **Service 类**（`SystemInfoService`）：带配置、生命周期、后台定时采集
- **跨服务注入**：工具函数通过 `inject: ['tools', 'systemInfo']` 声明依赖
- **事件发射**：`system-info/snapshot` 事件，每次采集后发射
- **工具注册**：`toolSystemInfo` 把 Service 能力暴露给 LLM
- **纯 Cordis 契约**：只 import `cordis`，不依赖 core 私有类型
- **类型断言**：用 `ToolRegistryLike` interface 避免重复声明 `ctx.tools`

参考它的源码（`packages/plugin-system-info/src/index.ts`）作为编写新插件的模板。

---

## 11. 测试

插件测试可以直接在 `packages/core/tests/` 里写，加载最小化的插件组合 + mock LLM：

```ts
import { test } from 'node:test'
import { Context } from 'cordis'
import { MyPluginService } from '@resolve-studio/plugin-<name>'

test('my plugin does something', async () => {
  const ctx = new Context()
  ctx.plugin(MyPluginService, { greeting: 'test' })
  // ... assertions
})
```

---

## 12. 发布到 npm（可选）

因为遵循纯 Cordis 契约，插件可以直接发布到 npm，被任何 Cordis-4 运行时加载：

```bash
cd packages/plugin-<name>
npm publish --access public
```

用户在他们的 `cordis.yml` 里写：

```yaml
plugins:
  - name: '@resolve-studio/plugin-<name>'
    config: { ... }
```

loader 会通过动态 `import()` 从 npm 解析，无需改代码。这就是 `plugin-hello` 验证过的跨生态可移植性。
