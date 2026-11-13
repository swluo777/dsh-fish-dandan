import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// 用最小浏览器环境验证客户端 bundle 的 loader 协议与插槽注册
function installBrowserEnv() {
  const styles = []
  const head = {
    appendChild: (el) => { styles.push(el); el.parentNode = head },
    removeChild: (el) => { const i = styles.indexOf(el); if (i >= 0) styles.splice(i, 1) },
  }
  const registry = new Map()
  const document = {
    baseURI: 'http://localhost:3000/',
    head,
    getElementById: (id) => styles.find((el) => el.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null }),
  }
  const window = {
    document,
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
      setItem(k, v) { this.store.set(k, v) },
    },
    __ModuleLoader__: {
      load: ({ id, factory }) => registry.set(id, factory),
    },
  }
  globalThis.window = window
  globalThis.document = document
  return { registry, styles }
}

test('客户端 bundle：遵循 loader 协议并导出 name/apply/inject', async () => {
  const { registry } = installBrowserEnv()
  const url = pathToFileURL(path.resolve('src/client/client.js')).href
  await import(`${url}?t=${Date.now()}`)

  const factory = registry.get('dsh-fish-dandan')
  assert.equal(typeof factory, 'function', '应向 __ModuleLoader__ 注册 dsh-fish-dandan')

  const exportsObj = factory((specifier) => {
    if (specifier === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: () => [null, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useRef: () => ({ current: null }),
      }
    }
    throw new Error(`未预期的模块：${specifier}`)
  })

  assert.equal(exportsObj.name, 'fish-dandan')
  assert.equal(typeof exportsObj.apply, 'function')
  assert.deepEqual(exportsObj.inject, ['slots'])
})

test('客户端 bundle：apply 注册设置分区与图标，并注入样式', async () => {
  const { registry, styles } = installBrowserEnv()
  const url = pathToFileURL(path.resolve('src/client/client.js')).href
  await import(`${url}?t=${Date.now() + 1}`)

  const exportsObj = registry.get('dsh-fish-dandan')((specifier) => ({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  }))

  const registered = []
  const injected = []
  const scope = {
    slots: {
      inject: (name, callback) => { injected.push(name); callback() },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  const ctx = {
    effect: (fn) => { fn() },
    slots: scope.slots,
  }

  exportsObj.apply(ctx)

  assert.deepEqual(injected.sort(), ['settings.section', 'settings.section.icon'])

  const section = registered.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section, '应注册设置分区')
  assert.equal(section.options.id, 'fish-dandan')
  assert.equal(section.options.label(), '我的大肥鱼')
  assert.equal(typeof section.component, 'function')

  const icon = registered.find((entry) => entry.options.name === 'settings.section.icon')
  assert.ok(icon, '应注册分区图标')
  assert.equal(icon.options.id, 'fish-dandan')

  assert.ok(styles.length >= 1, '应注入一份样式')
  assert.ok(styles[0].textContent.includes('.fd-panel'))
  // 设置表单已经全部搬到网页版，DSH 面板里不应再出现输入控件样式
  assert.ok(!styles[0].textContent.includes('.fd-input'))
  assert.ok(!styles[0].textContent.includes('.fd-area'))
})

test('设置卡片：JSX 类名与 CSS 选择器使用同一个前缀', () => {
  const source = readFileSync(path.resolve('src/client/client.js'), 'utf8')
  assert.ok(source.includes('className: "fd-panel"'), '卡片根节点应使用 fd-panel')
  assert.ok(!source.includes('"fs-'), 'JSX 里不应再残留 fs- 前缀')
})

test('设置分区只保留一个入口：不渲染任何设置表单', async () => {
  const { registry } = installBrowserEnv()
  const url = pathToFileURL(path.resolve('src/client/client.js')).href
  await import(`${url}?t=${Date.now() + 2}`)

  const overview = {
    persona: { name: '大肥鱼' },
    memory: { total: 3 },
    decision: { state: 'rest', label: '休息' },
    uiUrl: 'http://127.0.0.1:1234/fish-dandan/ui',
  }
  // 固定首屏数据；不回放 effect，避免真实 fetch
  let call = 0
  const exportsObj = registry.get('dsh-fish-dandan')((specifier) => {
    if (specifier !== 'react') throw new Error(`未预期的模块：${specifier}`)
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        call += 1
        if (call === 1) return [overview, () => {}]
        return [typeof init === 'function' ? init() : init, () => {}]
      },
      useEffect: () => {},
    }
  })

  const tree = exportsObj.Card()
  const all = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object') return
    all.push(node)
    ;(node.children || []).forEach(walk)
  }
  walk(tree)

  const links = all.filter((node) => node.type === 'a')
  assert.equal(links.length, 1, '只应有一个跳转链接')
  assert.equal(links[0].props.href, 'http://127.0.0.1:1234/fish-dandan/ui')
  assert.equal(all.filter((node) => node.type === 'input' || node.type === 'textarea').length, 0)
  assert.ok(JSON.stringify(tree).includes('打开设置页'))
})

test('设置卡片：服务不可用时提示「重启 DSH 后生效」', async () => {
  const { registry } = installBrowserEnv()
  const url = pathToFileURL(path.resolve('src/client/client.js')).href
  await import(`${url}?t=${Date.now() + 3}`)

  let call = 0
  const exportsObj = registry.get('dsh-fish-dandan')((specifier) => {
    if (specifier !== 'react') throw new Error(`未预期的模块：${specifier}`)
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        call += 1
        if (call === 1) return [null, () => {}]
        return ["内部错误，详情见日志", () => {}]
      },
      useEffect: () => {},
    }
  })

  const tree = exportsObj.Card()
  const json = JSON.stringify(tree)
  assert.ok(json.includes('设置页不可用'), '不可用状态仍要显示')
  assert.ok(json.includes('需要重启 DSH 才能生效'), '刚启用/重新启用插件导致的不可用要提示重启')
  assert.ok(json.includes('内部错误，详情见日志'), '原始错误仍然展示')
  assert.ok(json.includes('重启前人格、记忆等其余部分照常工作'), '说明重启前插件并未失效')
})
