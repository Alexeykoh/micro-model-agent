import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, normalizePath } from '../fs/path-utils.js';
import { fsError, fsOk } from '../fs/types.js';

/**
 * Project scaffolding tool.
 * Creates complete project structure programmatically (not via model).
 * Supports: vite-react-ts, vite-vanilla-ts, node-express-ts
 *
 * @module tools/native/scaffold
 */

interface ScaffoldTemplate {
  name: string;
  files: Record<string, string | ((dir: string) => string)>;
}

const TEMPLATES: Record<string, ScaffoldTemplate> = {
  'vite-react-ts': {
    name: 'Vite + React + TypeScript',
    files: {
      'package.json': (dir) => JSON.stringify({
        name: dir || 'app',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: {
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
          '@vitejs/plugin-react': '^4.3.0',
          typescript: '^5.7.0',
          vite: '^6.0.0',
        },
      }, null, 2),

      'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,

      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`,

      'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

      'src/main.tsx': `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,

      'src/App.tsx': `function App() {
  return (
    <div>
      <h1>Hello Vite + React</h1>
    </div>
  )
}

export default App
`,
    },
  },

  'vite-vanilla-ts': {
    name: 'Vite + Vanilla TypeScript',
    files: {
      'package.json': (dir) => JSON.stringify({
        name: dir || 'app',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
        devDependencies: { typescript: '^5.7.0', vite: '^6.0.0' },
      }, null, 2),

      'vite.config.ts': `import { defineConfig } from 'vite'

export default defineConfig({})
`,

      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,

      'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,

      'src/main.ts': `console.log('Hello from Vite!')
`,
    },
  },

  'node-express-ts': {
    name: 'Node.js + Express + TypeScript',
    files: {
      'package.json': (dir) => JSON.stringify({
        name: dir || 'app',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js' },
        dependencies: { express: '^4.21.0' },
        devDependencies: {
          '@types/express': '^5.0.0',
          '@types/node': '^22.0.0',
          typescript: '^5.7.0',
          tsx: '^4.0.0',
        },
      }, null, 2),

      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,

      'src/index.ts': `import express from 'express'

const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.json({ message: 'Hello from Express!' })
})

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`)
})
`,
    },
  },
};

export const scaffoldDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'scaffold',
    description: 'Create a complete project structure programmatically. Supports: vite-react-ts, vite-vanilla-ts, node-express-ts. Creates all files at once (package.json, config, source files). Use this INSTEAD of creating files manually for known project types.',
    parameters: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['vite-react-ts', 'vite-vanilla-ts', 'node-express-ts'],
          description: 'Project template to scaffold',
        },
        dir: {
          type: 'string',
          description: 'Directory name for the project (e.g. "todo-app")',
        },
      },
      required: ['template', 'dir'],
    },
  },
};

export const scaffoldHandler: ToolHandler = {
  name: 'scaffold',
  definition: scaffoldDefinition,
  async execute(args, ctx) {
    const template = String(args.template ?? '');
    const dir = String(args.dir ?? '');

    if (!template || !TEMPLATES[template]) {
      return fsError(`Unknown template: "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
    }
    if (!dir) {
      return fsError('dir is required. Usage: scaffold({template:"vite-react-ts", dir:"todo-app"})');
    }

    const resolved = resolvePath(dir, ctx.cwd);
    if (!resolved.ok) return fsError(resolved.error);

    const projectDir = resolved.abs;
    const tmpl = TEMPLATES[template];
    const createdFiles: string[] = [];

    try {
      // Create project directory
      mkdirSync(projectDir, { recursive: true });

      for (const [relPath, content] of Object.entries(tmpl.files)) {
        const filePath = join(projectDir, relPath);
        const fileDir = dirname(filePath);

        // Create parent directories
        mkdirSync(fileDir, { recursive: true });

        // Generate content (some files need the dir name)
        const fileContent = typeof content === 'function'
          ? content(dir)
          : content;

        writeFileSync(filePath, fileContent, 'utf-8');
        createdFiles.push(relPath);
      }

      const fileList = createdFiles.map(f => `  ✅ ${f}`).join('\n');
      return fsOk(
        `Scaffolded ${tmpl.name} project in ${normalizePath(dir)}/\n\nCreated ${createdFiles.length} files:\n${fileList}\n\nNext steps:\n  cd ${dir}\n  npm install\n  npm run dev`
      );
    } catch (e: any) {
      return fsError(`Scaffold failed: ${e.message}`);
    }
  },
};
