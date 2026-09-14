import type { ComponentHandler } from '@/core/components/base.js';

export class ComponentHandlerRegistry {
  private readonly handlers = new Map<string, ComponentHandler>();

  register(handler: ComponentHandler): this {
    this.handlers.set(handler.componentType, handler);
    return this;
  }

  get(componentType: string): ComponentHandler | undefined {
    return this.handlers.get(componentType);
  }

  has(componentType: string): boolean {
    return this.handlers.has(componentType);
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
