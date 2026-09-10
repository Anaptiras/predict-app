export type OddsOutcome = { name: string; price: number; point?: number };
export type OddsMarket = { key: string; last_update?: string; outcomes: OddsOutcome[] };
export type OddsBookmaker = { key: string; title: string; last_update?: string; markets: OddsMarket[] };
export type OddsEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
};

export type ScoreEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: Array<{ name: string; score: string }> | null;
  last_update?: string;
};

export function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function consensusH2H(event: OddsEvent) {
  const bySelection = new Map<string, { prices: number[]; updates: string[]; books: Set<string> }>();

  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets?.find((m) => m.key === 'h2h');
    if (!market) continue;

    for (const outcome of market.outcomes ?? []) {
      if (!Number.isFinite(outcome.price) || outcome.price <= 1) continue;
      const row = bySelection.get(outcome.name) ?? { prices: [], updates: [], books: new Set<string>() };
      row.prices.push(outcome.price);
      row.books.add(bookmaker.key);
      if (market.last_update) row.updates.push(market.last_update);
      else if (bookmaker.last_update) row.updates.push(bookmaker.last_update);
      bySelection.set(outcome.name, row);
    }
  }

  return [...bySelection.entries()].flatMap(([selection, row]) => {
    const price = median(row.prices);
    if (!price) return [];
    const sourceLastUpdate = row.updates.length
      ? row.updates.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      : new Date().toISOString();
    return [{
      selection,
      referenceOdds: Math.round(price * 1000) / 1000,
      bookmakerCount: row.books.size,
      sourceLastUpdate,
    }];
  });
}

export function quotaHeaders(response: Response) {
  const asInt = (name: string) => {
    const raw = response.headers.get(name);
    return raw == null ? null : Number.parseInt(raw, 10);
  };
  return {
    remaining: asInt('x-requests-remaining'),
    used: asInt('x-requests-used'),
    cost: asInt('x-requests-last'),
  };
}
