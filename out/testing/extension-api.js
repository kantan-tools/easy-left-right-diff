"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExtensionApi = createExtensionApi;
function createExtensionApi(health, testing) {
    const frozenHealth = Object.freeze({ ...health });
    return Object.freeze({
        getHealth: () => frozenHealth,
        getTesting: () => testing,
    });
}
