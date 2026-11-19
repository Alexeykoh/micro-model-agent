// Совместимый реэкспорт: поиск по workspace переехал в общий runtime-слой
// (split W10), чтобы им пользовались и `mma web`, и `mma serve`.
export * from "../../../runtime/file-search";
