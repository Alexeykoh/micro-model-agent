# План: REST API для блога на Express + SQLite

## Цель
Создать полноценный REST API для блога с:
- CRUD постов
- Комментарии к постам
- Авторизация (JWT)
- Роли: admin, author, user

## Структура проекта (в blog_api_test/)

blog_api_test/
├── src/
│   ├── index.ts              # Express сервер
│   ├── config/
│   │   └── database.ts       # Настройка SQLite
│   ├── controllers/
│   │   ├── authController.ts
│   │   ├── postController.ts
│   │   └── commentController.ts
│   ├── models/
│   │   ├── user.ts
│   │   ├── post.ts
│   │   └── comment.ts
│   ├── routes/
│   │   ├── authRoutes.ts
│   │   ├── postsRoutes.ts
│   │   └── commentsRoutes.ts
│   ├── middleware/
│   │   ├── auth.ts           # JWT проверка
│   │   └── errorHandler.ts
│   └── types/
│       └── user.ts           # Типы пользователя
├── .env.example
├── package.json
└── tsconfig.json


## Функционал
- **Регистрация/Логин**: JWT токены, bcrypt для паролей
- **Посты**: CRUD с ролями (admin создаёт всех, author создаёт свои)
- **Комментарии**: Только автор поста или admin может писать
- **Валидация**: Zod схемы
- **Ошибки**: Единый errorHandler middleware

## Технологии
- Express 5.x
- SQLite + better-sqlite3 (sync API)
- JWT для авторизации
- bcryptjs для хеширования
- Zod валидация

## Этапы
1. Инициализация проекта (package.json, tsconfig.json)
2. Настройка Express сервера
3. База данных SQLite + миграции
4. Модели пользователей и ролей
5. Контроллеры и маршруты
6. Middleware (auth, errorHandler)
7. Валидация схем
8. Тестирование
