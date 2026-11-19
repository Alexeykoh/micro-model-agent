---
name: typescript-expert
description: TypeScript type system, generics, advanced patterns, compiler API
keywords: [typescript, types, generics, tsconfig, compiler, interface, type]
mma_version: 2
---

# TypeScript Expert

## Key Patterns

- Use `readonly` for immutable properties
- Prefer `interface` over `type` for object shapes
- Use `as const` for literal types
- Prefer `unknown` over `any` for type safety

## Common Pitfalls

- Avoid `any` — use `unknown` + type guards
- Don't use `enum` — use `const` objects or union types
- Avoid `namespace` — use ES modules

## Type Guards

```ts
function isString(val: unknown): val is string {
  return typeof val === 'string'
}
```

## Generics

- Use `extends` for constraints
- Use `infer` for conditional type extraction
- Prefer explicit over implicit for complex cases
