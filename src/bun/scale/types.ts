export type ProgressFn = (step: string, detail: string) => void;

export function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [scale:${context}]`, ...args);
}
