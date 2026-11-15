/**
 * The browser's own functions the shim itself measures with, as they are when this module is
 * evaluated: the shim's modules load with the first shim surface, and nothing patches before them.
 * The space reads its probe through `elementRect`, the event part reads the true pointer position
 * through the two getters. (The spike's measuring code has a capture of its own, taken even
 * earlier, in native-geometry.ts. Strategy code does not import that.)
 */
const getter = (key: string): ((this: MouseEvent) => number) =>
  Object.getOwnPropertyDescriptor(MouseEvent.prototype, key)?.get as (this: MouseEvent) => number;

export const natives = {
  elementRect: Element.prototype.getBoundingClientRect,
  clientX: getter("clientX"),
  clientY: getter("clientY"),
} as const;
