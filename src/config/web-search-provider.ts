/**
 * Источник выдачи веб-поиска (`webSearch.provider`) — единственная точка правды:
 * реестр конфига, тул `web_search` и UI берут значения отсюда.
 */
export type WebSearchProvider = "duckduckgo" | "tavily" | "searxng";

/** Значения enum в порядке показа (реестр конфига + селект в панели). */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [
  "duckduckgo",
  "tavily",
  "searxng",
];
