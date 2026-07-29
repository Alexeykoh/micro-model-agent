import * as readline from 'readline'
import * as net from 'net'

interface SetupAnswers {
  provider: string
  apiBase: string
  apiKey: string
  model: string
  port: number
}

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const available = await checkPort(port)
    if (available) return port
  }
  return start
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '127.0.0.1')
  })
}

async function testConnection(apiBase: string, apiKey: string): Promise<boolean> {
  try {
    const url = `${apiBase.replace(/\/+$/, '')}/models`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })

    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

export async function runSetup(): Promise<SetupAnswers> {
  console.log('MMA Setup Wizard\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const provider = await ask(rl, 'LLM Provider', 'openai')
  const apiBase = await ask(rl, 'API Base URL', 'https://api.openai.com/v1')
  const apiKey = await ask(rl, 'API Key')
  const model = await ask(rl, 'Model name', provider === 'openai' ? 'gpt-4o-mini' : 'qwen2.5:7b')
  const port = await findAvailablePort(3000, 3010)

  console.log('\nTesting connection...')
  const connected = await testConnection(apiBase, apiKey)
  if (connected) {
    console.log('✓ Connection successful')
  } else {
    console.log('⚠ Could not connect — check your API endpoint and key')
  }

  console.log(`\nAvailable port: ${port}`)

  rl.close()
  console.log('\nSetup complete!')

  return { provider, apiBase, apiKey, model, port }
}

export { findAvailablePort, checkPort, testConnection }
