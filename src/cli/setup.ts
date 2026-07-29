import * as readline from 'readline'

interface SetupAnswers {
  provider: string
  apiBase: string
  apiKey: string
  model: string
  contextWindow: number
  maxToolIterations: number
  locale: string
}

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

const KNOWN_PORTS = [
  { port: 1234, label: 'LM Studio' },
  { port: 11434, label: 'Ollama' },
  { port: 8080, label: 'vLLM / custom' },
  { port: 4891, label: 'GPT4All' },
]

async function scanPorts(): Promise<{ label: string; url: string }[]> {
  const found: { label: string; url: string }[] = []
  for (const { port, label } of KNOWN_PORTS) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(`http://localhost:${port}/v1/models`, { signal: controller.signal })
      clearTimeout(timeout)
      if (resp.ok) {
        found.push({ label, url: `http://localhost:${port}/v1` })
      }
    } catch { /* port not available */ }
  }
  return found
}

async function fetchModels(apiBase: string, apiKey: string): Promise<string[]> {
  try {
    const url = `${apiBase.replace(/\/+$/, '')}/models`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!resp.ok) return []
    const data = await resp.json() as any
    const models = (data.data || data || [])
      .map((m: any) => m.id || m.name || m.model || '')
      .filter(Boolean)
    return models
  } catch {
    return []
  }
}

async function testChat(apiBase: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const url = `${apiBase.replace(/\/+$/, '')}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 20,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!resp.ok) return false
    const data = await resp.json() as any
    const text = data.choices?.[0]?.message?.content || ''
    return text.length > 0
  } catch {
    return false
  }
}

export async function runSetup(): Promise<SetupAnswers> {
  console.log('\n  MMA Setup Wizard v2\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('  Scanning local LLM servers...')
  const found = await scanPorts()
  let apiBase = ''
  let provider = 'openai-compat'

  if (found.length > 0) {
    console.log(`  Found ${found.length} server(s):`)
    found.forEach((f, i) => console.log(`    ${i + 1}. ${f.label.padEnd(14)} ${f.url}`))
    const choice = await ask(rl, '\n  Select server (1-' + found.length + ')', '1')
    const idx = Math.max(0, Math.min(found.length - 1, (parseInt(choice) || 1) - 1))
    apiBase = found[idx].url
    provider = 'openai-compat'
  } else {
    console.log('  No local servers found. Enter URL manually.')
    apiBase = await ask(rl, '  API Base URL', 'http://localhost:1234/v1')
    provider = await ask(rl, '  Provider type', 'openai-compat')
  }

  const apiKey = await ask(rl, '  API Key (press Enter to skip)', 'not-needed')

  console.log('  Fetching model list...')
  const models = await fetchModels(apiBase, apiKey)
  let model = ''
  if (models.length > 0) {
    console.log(`  Available models:`)
    models.slice(0, 10).forEach((m, i) => console.log(`    ${i + 1}. ${m}`))
    const choice = await ask(rl, '  Select model (1-' + Math.min(models.length, 10) + ')', '1')
    const idx = Math.max(0, Math.min(models.length - 1, (parseInt(choice) || 1) - 1))
    model = models[idx]
  } else {
    model = await ask(rl, '  Model name', 'qwen3.5-9b')
  }

  console.log(`\n  Testing chat with model "${model}"...`)
  const connected = await testChat(apiBase, apiKey, model)
  if (connected) {
    console.log('  OK — connection successful')
  } else {
    console.log('  WARNING: could not connect — check your API endpoint and key')
  }

  console.log('\n  --- Agent settings ---')
  const contextWindow = parseInt(await ask(rl, '  Context window (tokens)', '32768'))
  const maxIterations = parseInt(await ask(rl, '  Max tool iterations', '25'))

  console.log('\n  --- Language ---')
  const locale = await ask(rl, '  UI language (en/ru)', 'en')

  rl.close()

  const answers: SetupAnswers = {
    provider,
    apiBase,
    apiKey: apiKey || 'not-needed',
    model,
    contextWindow,
    maxToolIterations: maxIterations,
    locale,
  }

  console.log('\n  Setup complete!\n')
  return answers
}
