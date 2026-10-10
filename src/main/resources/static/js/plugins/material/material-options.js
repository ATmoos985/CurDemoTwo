/** Material choices always come from persisted inventory, never from a preset. */
export function syncMaterialOptions(rolls, options = {}) {
    const selector = document.getElementById('sel-mother-roll-id');
    const materials = document.getElementById('task-material');
    const preferred = options.rollId ?? selector?.value;
    const selected = rolls.find(roll => roll.rollId === preferred)
        || (options.fallback === false ? null : rolls[0]);
    if (selector) {
        const entries = rolls.map(roll => new Option(`${roll.rollId} (${roll.rollModel} · ${roll.width} mm)`, roll.rollId));
        if (!selected) entries.unshift(new Option(rolls.length ? '请选择在库母卷' : '暂无母卷，请先录入', ''));
        selector.replaceChildren(...entries);
        selector.value = selected?.rollId || '';
        selector.disabled = rolls.length === 0;
    }
    if (materials) {
        const model = options.model ?? materials.value;
        const models = [...new Set([...rolls.map(roll => roll.rollModel), model].filter(Boolean))];
        const chosen = model || selected?.rollModel || (options.fallback === false ? '' : models[0]) || '';
        materials.replaceChildren(new Option('请选择材料型号（导入时自动填写）', ''), ...models.map(value => new Option(value, value)));
        materials.value = chosen;
    }
}
