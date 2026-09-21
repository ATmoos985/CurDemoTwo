/**
 * 【微内核架构】事件总线 (EventBus)
 * 解除组件间强耦合，通过异步事件解耦发布与订阅
 */
class EventBus {
    constructor() {
        this.listeners = new Map();
    }

    /**
     * 订阅事件
     * @param {string} event 事件名称
     * @param {Function} handler 处理函数
     */
    on(event, handler) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
        return () => this.off(event, handler);
    }

    /**
     * 取消订阅
     * @param {string} event 事件名称
     * @param {Function} handler 处理函数
     */
    off(event, handler) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).delete(handler);
            if (this.listeners.get(event).size === 0) {
                this.listeners.delete(event);
            }
        }
    }

    /**
     * 广播事件
     * @param {string} event 事件名称
     * @param {any} payload 事件数据
     */
    emit(event, payload) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(handler => {
                try {
                    handler(payload);
                } catch (err) {
                    console.error(`[EventBus] Error in handler for event "${event}":`, err);
                }
            });
        }
    }

    /**
     * 仅触发一次
     * @param {string} event 事件名称
     * @param {Function} handler 处理函数
     */
    once(event, handler) {
        const wrapper = (payload) => {
            this.off(event, wrapper);
            handler(payload);
        };
        this.on(event, wrapper);
    }
}

export const bus = new EventBus();
