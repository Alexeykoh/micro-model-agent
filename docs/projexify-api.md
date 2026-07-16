# Projexify External API

## Быстрый старт

### 1. Получение токена
1. Откройте projexify → Настройки → Интеграции → Создать токен
2. Скопируйте токен (pxt_...) — показывается только один раз

### 2. Базовый URL
`http://10.253.232.115/api/v1/external`

### 3. Аутентификация
```
Authorization: Bearer pxt_ogroc0AvBXZdITpX62ZhJ8uPGgyLwfOStrsASFCU
```

## Типы данных

### Project
```json
{
  "id": "string",
  "name": "string",
  "icon": "string | null",
  "iconColor": "string | null",
  "workspace": { "id": "string", "name": "string" },
  "_count": { "tasks": "number", "members": "number" }
}
```

### Task
```json
{
  "id": "string",
  "title": "string",
  "shortId": "string",
  "description": "string | null",
  "priority": "LOW | MEDIUM | HIGH | CRITICAL",
  "type": "REGULAR | URGENT",
  "status": { "id": "string", "name": "string", "color": "string", "icon": "string | null" },
  "assignees": [{ "user": { "id": "string", "firstName": "string", "lastName": "string | null" } }],
  "checklistItems": [{ "id": "string", "text": "string", "checked": "boolean" }],
  "subtasks": [{ "id": "string", "title": "string", "status": { "name": "string" } }],
  "customFieldValues": [{ "fieldId": "string", "value": "any", "field": { "key": "string", "label": "string", "type": "string" } }],
  "taskCategory": { "id": "string", "name": "string", "icon": "string | null", "iconColor": "string | null" } | null,
  "createdAt": "string",
  "updatedAt": "string",
  "dueDate": "string | null",
  "estimatedTime": "number | null"
}
```

### TaskStatus
```json
{
  "id": "string",
  "name": "string",
  "color": "string",
  "icon": "string | null",
  "order": "number",
  "isDefault": "boolean"
}
```

### ProjectMember
```json
{
  "userId": "string",
  "role": "OWNER | ADMIN | MEMBER | GUEST",
  "user": {
    "id": "string",
    "firstName": "string",
    "lastName": "string | null",
    "username": "string | null",
    "avatar": "string | null"
  }
}
```

## Эндпоинты

### Проекты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/projects` | Список проектов |
| GET | `/projects/:id` | Детали проекта |
| GET | `/projects/:id/statuses` | Статусы задач |
| GET | `/projects/:id/members` | Участники |
| GET | `/projects/:id/categories` | Категории задач |
| POST | `/projects/:id/categories` | Создать категорию |
| PATCH | `/projects/:id/categories/:cid` | Обновить категорию |
| DELETE | `/projects/:id/categories/:cid` | Удалить категорию |

### Задачи

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/projects/:id/tasks` | Список задач (?q, statusId, assigneeId, priority, sortBy, sortOrder, limit, skip) |
| GET | `/projects/:id/tasks/:tid` | Детали задачи (включает customFieldValues, subtasks, checklistItems) |
| POST | `/projects/:id/tasks` | Создать (title, description, statusId, priority, dueDate, estimatedTime, taskCategoryId, assigneeUserIds) |
| PATCH | `/projects/:id/tasks/:tid` | Обновить |
| DELETE | `/projects/:id/tasks/:tid` | Удалить |
| PATCH | `/projects/:id/tasks/:tid/status` | Сменить статус (statusId) |
| POST | `/projects/:id/tasks/:tid/assignees/:uid` | Назначить исполнителя |
| DELETE | `/projects/:id/tasks/:tid/assignees/:uid` | Снять исполнителя |
| PATCH | `/projects/:id/tasks/:tid/approve` | Одобрить задачу |
| POST | `/projects/:id/tasks/:tid/archive` | Архивировать |
| POST | `/projects/:id/tasks/:tid/restore` | Восстановить из архива |

### Комментарии

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/projects/:id/tasks/:tid/comments` | Комментарии |
| POST | `/projects/:id/tasks/:tid/comments` | Добавить (content) |

### Чеклист

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/projects/:id/tasks/:tid/checklist` | Добавить пункт (title) |
| PATCH | `/projects/:id/tasks/:tid/checklist/:iid` | Обновить (title, checked) |
| DELETE | `/projects/:id/tasks/:tid/checklist/:iid` | Удалить пункт |

### Ссылки между задачами

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/projects/:id/tasks/:tid/links` | Добавить (toTaskId, type: BLOCKS\|BLOCKED_BY) |
| DELETE | `/projects/:id/tasks/:tid/links/:lid` | Удалить |

### Трекинг времени

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/projects/:id/tasks/:tid/time-tracking/start` | Начать трекинг |
| POST | `/projects/:id/tasks/:tid/time-tracking/stop` | Остановить трекинг |

### Подзадачи

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/projects/:id/tasks/:tid/subtasks` | Подзадачи |
| POST | `/projects/:id/tasks/:tid/subtasks` | Создать |
| PATCH | `/projects/:id/tasks/:tid/subtasks/:sid` | Обновить |
| DELETE | `/projects/:id/tasks/:tid/subtasks/:sid` | Удалить |

### Кастомные поля

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/projects/:id/custom-fields` | Кастомные поля |
| POST | `/projects/:id/custom-fields` | Создать |
| PATCH | `/projects/:id/custom-fields/:fid` | Обновить |
| DELETE | `/projects/:id/custom-fields/:fid` | Удалить |
| PATCH | `/projects/:id/custom-fields/tasks/:tid/values` | Установить значения (values: { fieldKey: value }) |

## Примеры (curl)

```bash
# Список проектов
curl -H "Authorization: Bearer pxt_огро..." /api/v1/external/projects

# Создать задачу
curl -X POST -H "Authorization: Bearer pxt_огро..." -H "Content-Type: application/json" \
  -d '{ "title": "Задача", "priority": "HIGH" }' \
  /api/v1/external/projects/PROJECT_ID/tasks

# Сменить статус
curl -X PATCH -H "Authorization: Bearer pxt_огро..." -H "Content-Type: application/json" \
  -d '{ "statusId": "STATUS_ID" }' \
  /api/v1/external/projects/PROJECT_ID/tasks/TASK_ID/status
```

## Ошибки

| Код | Значение | Причина |
|-----|----------|---------|
| 401 | Unauthorized | Неверный или отсутствующий токен |
| 403 | Forbidden | Недостаточно прав или токен не привязан к проекту |
| 404 | Not Found | Проект или задача не найдены |
| 400 | Bad Request | Неверный формат данных |
| 409 | Conflict | Нарушение правил переходов статусов |

## Важно

- Токен действует от имени пользователя с его правами (RBAC)
- Токен привязан к проекту — доступ только к нему
- PowerShell: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
