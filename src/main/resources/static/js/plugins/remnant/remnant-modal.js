/**
 * 现场料头库存池与扫码识别弹窗插件 (Remnant Modal Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { switchCutMode } from './remnant-shelf.js';

export async function openRemnantModal() {
    const modal = document.getElementById("remnant-modal");
    if (modal) modal.style.display = "flex";
    await refreshRemnantsList();
}

export function closeRemnantModal() {
    const modal = document.getElementById("remnant-modal");
    if (modal) modal.style.display = "none";
}

export async function refreshRemnantsList() {
    const container = document.getElementById("remnant-cards-container");
    if (!container) return;
    container.innerHTML = `<div style="color: #a1a1aa; font-size: 12px; padding: 20px; text-align: center;">正在读取现场料头库存...</div>`;
    try {
        const res = await fetch("/api/remnants");
        if (res.ok) {
            const list = await res.json();
            const headCount = document.getElementById("header-remnant-count");
            if (headCount) headCount.innerText = list.length;
            if (list.length === 0) {
                container.innerHTML = `<div style="color: #a1a1aa; font-size: 12px; padding: 20px; text-align: center;">当前现场料头库存为空。</div>`;
                return;
            }
            container.innerHTML = list.map(r => `
                <div class="shelf-card-box" style="padding: 10px 14px; margin-bottom: 8px;">
                    <div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-family: monospace; font-size: 13px; font-weight: 700; color: var(--accent-blue);">${r.id}</span>
                            <span class="${r.hasDefect ? 'badge-cut' : 'badge-piece'}" style="padding: 1px 6px; font-size: 10px;">
                                ${r.hasDefect ? '带疵需避让' : '完好可用'}
                            </span>
                            <span style="color: var(--text-muted); font-size: 11px;">${r.materialBatch || '标准面料'}</span>
                        </div>
                        <div style="font-size: 12px; color: var(--text-main); margin-top: 4px;">
                            规格: <b>${r.width} × ${r.length} mm</b> (${r.area.toFixed(2)} m²) | 
                            存放库位: <span style="color: var(--accent-amber);">${r.location}</span> | 
                            来源: <span>${r.sourceRollId || '母卷切出'}</span>
                        </div>
                        <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                            ${r.defectDesc || '登记时间: ' + (r.createdAt || '近期')}
                        </div>
                    </div>
                    <div>
                        <button class="tool-btn active" style="font-size: 11px; padding: 6px 14px;" onclick="window.camApp.selectAndLoadRemnant('${r.id}')">
                            装载至机台切割
                        </button>
                    </div>
                </div>
            `).join("");
        }
    } catch (e) {
        container.innerHTML = `<div style="color: #ef4444; font-size: 12px; padding: 20px; text-align: center;">读取料头库失败: ${e.message}</div>`;
    }
}

export async function executeBarcodeScan() {
    const code = document.getElementById("inp-scan-barcode").value.trim();
    if (!code) {
        alert("请输入或扫描料头条码！");
        return;
    }
    try {
        const res = await fetch("/api/remnants/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: code })
        });
        if (res.ok) {
            const rem = await res.json();
            if (rem && rem.id) {
                selectAndLoadRemnant(rem.id);
            } else {
                alert(`【未识别到料头】条码 [${code}] 在现场库存中不存在！`);
            }
        }
    } catch (e) {
        alert("扫码识别异常: " + e.message);
    }
}

export function quickScan(id) {
    const inp = document.getElementById("inp-scan-barcode");
    if (inp) inp.value = id;
    executeBarcodeScan();
}

export async function selectAndLoadRemnant(remId) {
    try {
        const res = await fetch("/api/remnants/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: remId })
        });
        if (res.ok) {
            const rem = await res.json();
            if (rem && rem.id) {
                closeRemnantModal();
                switchCutMode("remnant", rem);
                alert(`成功识别并装载料头 [${rem.id}]！\n规格: ${rem.width}×${rem.length} mm\n库位: ${rem.location}\n模式: 模式二：料头复用精益切割\n母卷实切扣减已锁定为 0mm，点击执行料头排料即可！`);
            }
        }
    } catch (e) {
        alert("装载料头失败: " + e.message);
    }
}
