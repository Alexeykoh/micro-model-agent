// Генераторы каркаса Angular 11 (F4 плагина `angular11`).
//
// Пишем только корректные по канону classic-NgModule файлы. В NgModule ничего
// не вписываем — правку модуля делает модель, видя diff (см. §2 A11-5 спеки).
// Здесь чистая функция: `scaffoldFiles` возвращает набор файлов, запись — тул.

/** Тип каркаса. */
export type ScaffoldKind = "component" | "pipe" | "module" | "service" | "directive" | "guard";

/** Имена каркаса: базовое (`user-card`) и класс (`UserCard`). */
export interface ScaffoldNames {
  base: string;
  className: string;
}

/** Разобрать входное имя в базовое и класс-имя. */
export function normaliseName(raw: string): ScaffoldNames | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const words = trimmed
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  // Отбрасываем служебный суффикс, если он передан: `user.service` → `user`.
  const suffix = words[words.length - 1].toLowerCase();
  const stripped = ["component", "pipe", "module", "service", "directive", "guard"].includes(suffix)
    ? words.slice(0, -1)
    : words;
  const final = stripped.length > 0 ? stripped : words;
  const className = final.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  const base = final.map((w) => w.toLowerCase()).join("-");
  if (!/^[A-Za-z][\w-]*$/.test(base)) return null;
  return { base, className };
}

/** Набор файлов каркаса: относительное имя → содержимое. */
export function scaffoldFiles(kind: ScaffoldKind, names: ScaffoldNames): Record<string, string> {
  const { base, className } = names;
  switch (kind) {
    case "component":
      return {
        [`${base}.component.ts`]: `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-${base}',\n  templateUrl: './${base}.component.html',\n  styleUrls: ['./${base}.component.css'],\n})\nexport class ${className}Component {}\n`,
        [`${base}.component.html`]: `<p>${base} works!</p>\n`,
        [`${base}.component.css`]: "",
      };
    case "pipe":
      return {
        [`${base}.pipe.ts`]: `import { Pipe, PipeTransform } from '@angular/core';\n\n@Pipe({ name: '${base}' })\nexport class ${className}Pipe implements PipeTransform {\n  transform(value: unknown, ...args: unknown[]): unknown {\n    return value;\n  }\n}\n`,
      };
    case "module":
      return {
        [`${base}.module.ts`]: `import { NgModule } from '@angular/core';\nimport { CommonModule } from '@angular/common';\n\n@NgModule({\n  declarations: [],\n  imports: [CommonModule],\n  exports: [],\n})\nexport class ${className}Module {}\n`,
      };
    case "service":
      return {
        [`${base}.service.ts`]: `import { Injectable } from '@angular/core';\n\n@Injectable({ providedIn: 'root' })\nexport class ${className}Service {}\n`,
      };
    case "directive":
      return {
        [`${base}.directive.ts`]: `import { Directive } from '@angular/core';\n\n@Directive({ selector: '[app${className}]' })\nexport class ${className}Directive {}\n`,
      };
    case "guard":
      return {
        [`${base}.guard.ts`]: `import { Injectable } from '@angular/core';\nimport { ActivatedRouteSnapshot, CanActivate, RouterStateSnapshot, UrlTree } from '@angular/router';\nimport { Observable } from 'rxjs';\n\n@Injectable({ providedIn: 'root' })\nexport class ${className}Guard implements CanActivate {\n  canActivate(\n    route: ActivatedRouteSnapshot,\n    state: RouterStateSnapshot,\n  ): Observable<boolean | UrlTree> | Promise<boolean | UrlTree> | boolean | UrlTree {\n    return true;\n  }\n}\n`,
      };
  }
}
