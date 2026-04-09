export function nextSelectedUseCaseKey(current: string | null, clicked: string) {
  return current === clicked ? null : clicked;
}
