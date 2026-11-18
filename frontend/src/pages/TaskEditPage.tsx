import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, fmtN, toast, loadSheetLib } from '@static/app/js/util.js';
import {
  fromTask,
  addDemand,
  mergeImport,
  taskProblems,
  lineLock,
  toPayload,
  demandTemplateCsv,
  withProblemType
} from '@static/app/js/model/task-form.js';
import { TASK_PACK_GROUPS, taskPackForm } from '@static/app/js/model/task-packs.js';
import { SLITTING } from '@static/app/js/model/slitting.js';
import { workflowTemplate } from '@static/app/js/model/showcase.js';
import {
  parseDemandSheet,
  parseDemandJSON,
  importedTask,
  importGroups
} from '@static/js/business/cutting/demand-import-model.js';
import {
  DXF_GARMENT_STYLES,
  buildDxfStyleParts,
  parseDxfGarmentText
} from '@static/js/nesting/dxf-garment-samples.js';

const ORIGINS: [string, string][] = [
  ['right-bottom', '右下'],
  ['left-bottom', '左下'],
  ['right-top', '右上'],
  ['left-top', '左上']
];

const draftKey = (id?: string | null) => 'cutplan.app.taskdraft.' + (id || 'new');

interface ImportState {
  result: any;
  groups: any[];
  gi: number;
  selected: Set<number>;
  source: string;
  append: boolean;
}

export const TaskEditPage: React.FC<{ params?: string[] }> = ({ params = [] }) => {
  const [taskId, templateId] = params;
  const routeTemplate = useMemo(
    () => (taskId === 'new' && templateId ? workflowTemplate(templateId) : null),
    [taskId, templateId]
  );
  const routePackId = routeTemplate ? 'showcase-' + templateId : '';
  const buildNewForm = (id: string) =>
    routeTemplate && id === routePackId
      ? fromTask(routeTemplate.task)
      : taskPackForm(id);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState<any>(null);
  const [completed, setCompleted] = useState<Record<string, number>>({});
  const [rolls, setRolls] = useState<any[]>([]);
  const [packId, setPackId] = useState<string>(routePackId);
  const [baseline, setBaseline] = useState<any>(() => buildNewForm(routePackId));
  const [form, setForm] = useState<any>(() => buildNewForm(routePackId));
  const [hasDraft, setHasDraft] = useState(false);
  const [imp, setImp] = useState<ImportState | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const storageKey = useMemo(
    () => draftKey(original?.id || (routeTemplate ? 'demo-' + templateId : null)),
    [original?.id, routeTemplate, templateId]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [detail, r] = await Promise.all([
          taskId && taskId !== 'new'
            ? requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId))
            : null,
          requestJSON('/api/rolls')
        ]);
        if (cancelled) return;
        const origTask = detail?.task || null;
        const compMap = detail?.completed || {};
        setRolls(r || []);
        setOriginal(origTask);
        setCompleted(compMap);

        const k = draftKey(
          origTask?.id || (routeTemplate ? 'demo-' + templateId : null)
        );
        let parsedDraft: any = null;
        try {
          parsedDraft = JSON.parse(localStorage.getItem(k) || 'null');
        } catch {}

        const useDraft = Boolean(
          parsedDraft && (!origTask || parsedDraft.revision === origTask.revision)
        );
        const resolvedPackId = origTask
          ? ''
          : parsedDraft?.taskPackId ?? routePackId;
        const resolvedBaseline = origTask
          ? fromTask(origTask)
          : buildNewForm(resolvedPackId);
        setPackId(resolvedPackId);
        setBaseline(resolvedBaseline);
        setHasDraft(useDraft);
        setForm(useDraft ? fromTask(parsedDraft) : resolvedBaseline);
      } catch (e: any) {
        if (!cancelled) setError(e.message || '加载任务失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, templateId, routeTemplate]);

  const updateAndPersist = (nextForm: any, nextPackId: string = packId) => {
    setForm(nextForm);
    setHasDraft(true);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(
          original ? nextForm : { ...nextForm, taskPackId: nextPackId }
        )
      );
    } catch {}
  };

  const models = useMemo(
    () => [...new Set(rolls.map((r) => r.rollModel).filter(Boolean))].sort(),
    [rolls]
  );

  const hasChangesFromBaseline = useMemo(
    () =>
      JSON.stringify(toPayload(form)) !== JSON.stringify(toPayload(baseline)),
    [form, baseline]
  );

  const isDirty = useMemo(
    () => !original || hasChangesFromBaseline,
    [original, hasChangesFromBaseline]
  );

  const problems: string[] = useMemo(
    () => taskProblems(form, { original, completed }),
    [form, original, completed]
  );

  const isSlitting = form.problemType === SLITTING;
  const typeLocked = Boolean(original && Object.keys(completed).length > 0);
  const totalPieces = (form.demands || []).reduce(
    (a: number, d: any) => a + (Number(d.quantity) || 0),
    0
  );

  const handlePackChange = (nextId: string) => {
    if (
      (hasChangesFromBaseline || imp) &&
      !confirm('切换示例包会替换当前草稿，继续切换？')
    ) {
      return;
    }
    const fresh = buildNewForm(nextId);
    setPackId(nextId);
    setBaseline(fresh);
    setImp(null);
    updateAndPersist(fresh, nextId);
  };

  const handleDiscard = () => {
    localStorage.removeItem(storageKey);
    setHasDraft(false);
    setImp(null);
    setPackId(routePackId);
    const fresh = original ? fromTask(original) : buildNewForm(routePackId);
    setBaseline(fresh);
    setForm(fresh);
  };

  const handleReloadLatest = async () => {
    if (!original?.id) return;
    try {
      const d = await requestJSON(
        '/api/cutting/tasks/' + encodeURIComponent(original.id)
      );
      const fresh = fromTask(d.task);
      setOriginal(d.task);
      setCompleted(d.completed || {});
      setBaseline(fresh);
      setForm(fresh);
      setConflict(false);
      setHasDraft(false);
      localStorage.removeItem(storageKey);
      toast('已载入最新版本');
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  const handleDxfPreset = (styleId: string) => {
    const style = (DXF_GARMENT_STYLES as any)[styleId];
    if (!style) return;
    const sizeCounts = styleId === 'DXF_3129' ? { M: 1, L: 1 } : { M: 2, L: 2 };
    const parts = buildDxfStyleParts(styleId, {
      sizeCounts,
      fabricFilter: '面布',
      splitMirrorPairs: true
    });
    const imported = {
      name: `${style.name} · 120/140码齐套搭切`,
      materialModel: style.materialModel,
      externalRef: `CAD纸样 ${style.file}`,
      demands: parts.map((p: any) => ({
        name: p.name,
        width: p.shape.width,
        length: p.shape.height,
        quantity: p.quantity,
        allowRotation: false,
        shape: p.shape
      }))
    };
    const next = mergeImport(
      {
        ...form,
        name: imported.name,
        materialModel: imported.materialModel,
        externalRef: imported.externalRef,
        process: {
          ...form.process,
          bedLength: styleId === 'DXF_3129' ? 4500 : 3600,
          cutOrigin: 'left-top'
        }
      },
      imported,
      { replace: true, completed }
    );
    updateAndPersist(next);
    toast(`已载入 ${style.file} (${parts.length} 项异形裁片轮廓)`);
  };

  const handleDownloadTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([demandTemplateCsv()], { type: 'text/csv;charset=utf-8' })
    );
    a.download = '需求导入模板.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleReadFile = async (file?: File) => {
    if (!file) return;
    try {
      let result: any;
      if (/\.json$/i.test(file.name)) {
        result = parseDemandJSON(JSON.parse(await file.text()));
      } else if (/\.dxf$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (!text.includes('Piece Name:') || text.includes('\uFFFD')) {
          try {
            text = new TextDecoder('gb18030').decode(buf);
          } catch {}
        }
        result = parseDxfGarmentText(text, file.name);
      } else {
        const XLSX = await loadSheetLib();
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = book.Sheets[book.SheetNames[0]];
        result = parseDemandSheet(
          XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
        );
      }
      const groups = importGroups(result);
      const gi = Math.max(
        0,
        groups.findIndex(
          (g: any) => g.materialModel === form.materialModel && g.index >= 0
        )
      );
      setImp({
        result,
        groups,
        gi,
        selected: new Set((groups[gi]?.demands || []).map((d: any) => d.id)),
        source: file.name,
        append: false
      });
    } catch (e: any) {
      toast('导入失败：' + e.message, true);
    }
  };

  const handleApplyImport = () => {
    if (!imp) return;
    try {
      const g = imp.groups[imp.gi] || imp.groups[0];
      if (
        form.materialModel &&
        g.materialModel !== form.materialModel &&
        !confirm(
          `导入的型号 ${g.materialModel} 与当前任务 ${form.materialModel} 不同，仍要导入吗？（型号保持当前值）`
        )
      ) {
        return;
      }
      const t = importedTask(imp.result, g.index, imp.source, [...imp.selected]);
      const next = mergeImport(form, t, { replace: !imp.append, completed });
      updateAndPersist(next);
      setImp(null);
      toast(`已导入 ${t.demands.length} 项需求，请核对后保存`);
    } catch (err: any) {
      toast(err.message, true);
    }
  };

  const handleSave = async () => {
    if (problems.length) {
      toast(problems[0], true);
      return;
    }
    setSaving(true);
    try {
      localStorage.setItem(storageKey, JSON.stringify(form));
      const task = await requestJSON('/api/cutting/tasks', toPayload(form));
      localStorage.removeItem(storageKey);
      toast(original ? '任务已保存' : '任务已创建');
      if (task.problemType === SLITTING) {
        location.hash = '#/slitting';
      } else {
        location.hash = '#/workbench/' + encodeURIComponent(task.id);
      }
    } catch (e: any) {
      setSaving(false);
      const isConflict = Boolean(
        original && /已更新|重新打开|revision/.test(e.message || '')
      );
      setConflict(isConflict);
      toast(
        (isConflict ? '任务已被他处修改：' : '保存失败，草稿已保留：') +
          e.message +
          (e.code === 'NETWORK' ? '（结果可能已生效，请到任务列表核对）' : ''),
        true
      );
    }
  };

  if (loading) {
    return (
      <div className="react-page">
        <div className="loading">加载任务表单中…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="react-page">
        <div className="error-box" role="alert">
          <b>操作未完成</b>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const p = form.process || {};
  const sp = form.slitting || {};
  const curGroup = imp ? imp.groups[imp.gi] || imp.groups[0] : null;

  return (
    <div className="react-page">
      <div className="ph">
        <h1>{original ? '编辑任务' : '新建任务'}</h1>
        <span className="crumb">
          {original
            ? `${original.name} · 版本 ${original.revision}`
            : '填写需求后保存，再进入工作台选料排料'}
        </span>
        {hasDraft && isDirty && <span className="tag warn">本机草稿</span>}
        <span className="sp" />
        <a
          className="btn"
          href={
            original
              ? `#/workbench/${encodeURIComponent(original.id)}`
              : '#/tasks'
          }
        >
          {original ? '返回工作台' : '返回任务'}
        </a>
        {isDirty && (
          <button type="button" className="btn" onClick={handleDiscard}>
            放弃修改
          </button>
        )}
        <button
          type="button"
          className="btn pri"
          disabled={problems.length > 0 || saving || !isDirty}
          onClick={handleSave}
        >
          {saving ? '保存中…' : original ? '保存修改' : '保存并进入工作台'}
        </button>
      </div>

      {routeTemplate && packId === routePackId && (
        <div className="notice">
          演示模板 · 型号 {routeTemplate.task.materialModel}。请先
          <a href={`#/inventory/receive/${encodeURIComponent(templateId || '')}`}>
            登记对应演示母卷
          </a>
          并完成检验；保存任务及后续报工会写入业务数据。
        </div>
      )}

      {conflict && (
        <div
          className="notice"
          style={{
            margin: '12px 16px 0',
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}
        >
          <span>
            任务已在别处被修改（版本已更新）。你的修改仍保留在本页，可对照后再载入最新版本重新编辑。
          </span>
          <span className="sp" />
          <button type="button" className="btn sm pri" onClick={handleReloadLatest}>
            载入最新版本（放弃本页修改）
          </button>
        </div>
      )}

      <div className="body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '340px 1fr',
            gap: 12,
            alignItems: 'start'
          }}
        >
          <div>
            <div className="box">
              <div className="pane-h">基本信息</div>
              <div className="form" style={{ gridTemplateColumns: '80px 1fr' }}>
                {!original && (
                  <>
                    <label htmlFor="task-pack">示例包</label>
                    <select
                      className="field"
                      id="task-pack"
                      disabled={saving}
                      value={packId}
                      onChange={(e) => handlePackChange(e.target.value)}
                    >
                      <option value="">空白任务</option>
                      {routeTemplate && (
                        <optgroup label="能力展示">
                          <option value={routePackId}>
                            {routeTemplate.task.name}
                          </option>
                        </optgroup>
                      )}
                      {TASK_PACK_GROUPS.map((group: any) => (
                        <optgroup key={group.name} label={group.name}>
                          {group.packs.map((pack: any) => (
                            <option key={pack.id} value={pack.id}>
                              {pack.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </>
                )}
                <label>任务名称</label>
                <input
                  className="field"
                  value={form.name || ''}
                  onChange={(e) => updateAndPersist({ ...form, name: e.target.value })}
                />
                <label>任务类型</label>
                <select
                  className="field"
                  disabled={typeLocked}
                  title={typeLocked ? '已有报工，不能更改类型' : undefined}
                  value={form.problemType || 'NESTING_2D'}
                  onChange={(e) => {
                    const width = Math.max(
                      0,
                      ...rolls
                        .filter((r) => r.rollModel === form.materialModel)
                        .map((r) => r.width)
                    );
                    updateAndPersist(withProblemType(form, e.target.value, width));
                  }}
                >
                  <option value="NESTING_2D">二维排料（裁片）</option>
                  <option value={SLITTING}>一维分切（分条）</option>
                </select>
                <label>材料型号</label>
                <div>
                  <input
                    className="field"
                    list="task-edit-models"
                    value={form.materialModel || ''}
                    style={{ width: '100%' }}
                    disabled={typeLocked}
                    title={typeLocked ? '已有报工，不能更改型号' : undefined}
                    onChange={(e) =>
                      updateAndPersist({ ...form, materialModel: e.target.value })
                    }
                  />
                  <datalist id="task-edit-models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                    在库同型号母卷{' '}
                    {rolls.filter((r) => r.rollModel === form.materialModel).length} 卷
                    {routeTemplate &&
                      packId === routePackId &&
                      routeTemplate.task.materialModel === form.materialModel && (
                        <>
                          {' '}
                          <a
                            href={`#/inventory/receive/${encodeURIComponent(
                              templateId || ''
                            )}`}
                          >
                            登记示例母卷
                          </a>
                        </>
                      )}
                  </div>
                </div>
                <label>来源</label>
                <input
                  className="field"
                  value={form.externalRef || ''}
                  placeholder="订单文件 / 外部单号"
                  onChange={(e) =>
                    updateAndPersist({ ...form, externalRef: e.target.value })
                  }
                />
              </div>
            </div>

            {isSlitting ? (
              <div className="box">
                <div className="pane-h">
                  分切参数<span className="sub">整数 mm · 每车长度 = 切头 + 卷长</span>
                </div>
                <div className="form" style={{ gridTemplateColumns: '110px 1fr' }}>
                  <label>左切边 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.leftTrim ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, leftTrim: Number(e.target.value) }
                      })
                    }
                  />
                  <label>右切边 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.rightTrim ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, rightTrim: Number(e.target.value) }
                      })
                    }
                  />
                  <label>组合宽度下限</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.minWidth ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, minWidth: Number(e.target.value) }
                      })
                    }
                  />
                  <label>组合宽度上限</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.maxWidth ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, maxWidth: Number(e.target.value) }
                      })
                    }
                  />
                  <label>宽度步长</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.widthStep ?? 1}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, widthStep: Number(e.target.value) }
                      })
                    }
                  />
                  <label>超产上限 卷</label>
                  <input
                    type="number"
                    className="field num"
                    value={sp.totalOverCap ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        slitting: { ...sp, totalOverCap: Number(e.target.value) }
                      })
                    }
                  />
                  <label>切头 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={p.trimStart ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, trimStart: Number(e.target.value) }
                      })
                    }
                  />
                  <label>切割基准</label>
                  <select
                    className="field"
                    value={p.cutOrigin || 'left-top'}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, cutOrigin: e.target.value }
                      })
                    }
                  >
                    {ORIGINS.map(([k, t]) => (
                      <option key={k} value={k}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="box">
                <div className="pane-h">工艺参数</div>
                <div className="form" style={{ gridTemplateColumns: '100px 1fr' }}>
                  <label>拉布长度 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={p.bedLength ?? 3000}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, bedLength: Number(e.target.value) }
                      })
                    }
                  />
                  <label>切头 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={p.trimStart ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, trimStart: Number(e.target.value) }
                      })
                    }
                  />
                  <label>件间距 mm</label>
                  <input
                    type="number"
                    className="field num"
                    value={p.pieceGap ?? 0}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, pieceGap: Number(e.target.value) }
                      })
                    }
                  />
                  <label>切割基准</label>
                  <select
                    className="field"
                    value={p.cutOrigin || 'left-top'}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, cutOrigin: e.target.value }
                      })
                    }
                  >
                    {ORIGINS.map(([k, t]) => (
                      <option key={k} value={k}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <label>第一刀方向</label>
                  <select
                    className="field"
                    value={p.firstStageOrientation || 'horizontal'}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, firstStageOrientation: e.target.value }
                      })
                    }
                  >
                    <option value="horizontal">横向</option>
                    <option value="vertical">纵向</option>
                  </select>
                  <label>允许旋转</label>
                  <select
                    className="field"
                    value={p.allowRotation ? '1' : '0'}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, allowRotation: e.target.value === '1' }
                      })
                    }
                  >
                    <option value="0">否</option>
                    <option value="1">是</option>
                  </select>
                  <label>允许纵切</label>
                  <select
                    className="field"
                    value={p.allowLongitudinal ? '1' : '0'}
                    onChange={(e) =>
                      updateAndPersist({
                        ...form,
                        process: { ...p, allowLongitudinal: e.target.value === '1' }
                      })
                    }
                  >
                    <option value="1">是</option>
                    <option value="0">否</option>
                  </select>
                </div>
              </div>
            )}

            {problems.length > 0 && (
              <div className="notice" style={{ margin: 0 }}>
                {problems.slice(0, 8).map((msg, idx) => (
                  <div key={idx}>{msg}</div>
                ))}
                {problems.length > 8 && <div>… 共 {problems.length} 项</div>}
              </div>
            )}
          </div>

          <div className="box" style={{ margin: 0 }}>
            <div className="pane-h">
              需求
              <span className="sub">
                {(form.demands || []).length} 项 · {fmtN(totalPieces)}{' '}
                {isSlitting ? '卷' : '件'}
              </span>
              <span className="sp" />
              {!isSlitting && (
                <div
                  className="seg"
                  style={{ marginRight: 6 }}
                  title="一键载入真实 CAD DXF 服装纸样裁片"
                >
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => handleDxfPreset('DXF_1226')}
                  >
                    DXF 1226卫衣
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => handleDxfPreset('DXF_20148D')}
                  >
                    DXF 20148D
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => handleDxfPreset('DXF_3129')}
                  >
                    DXF 3129套装
                  </button>
                </div>
              )}
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                导入 Excel / CSV / JSON / DXF
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.json,.dxf"
                  hidden
                  onChange={(e) => {
                    handleReadFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="btn sm" onClick={handleDownloadTemplate}>
                下载模板
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => updateAndPersist(addDemand(form))}
              >
                ＋ 添加需求
              </button>
            </div>

            {imp && curGroup && (
              <div
                style={{
                  borderBottom: '1px solid var(--line-2)',
                  background: 'var(--panel-2)'
                }}
              >
                <div className="pane-h">
                  导入预览
                  <span className="sub">
                    {imp.result.format} · {imp.source}
                  </span>
                  <span className="sp" />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setImp(null)}
                  >
                    取消
                  </button>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '8px 12px',
                    alignItems: 'center',
                    flexWrap: 'wrap'
                  }}
                >
                  <select
                    className="field"
                    value={imp.gi}
                    onChange={(e) => {
                      const gi = Number(e.target.value);
                      setImp({
                        ...imp,
                        gi,
                        selected: new Set(
                          (imp.groups[gi]?.demands || []).map((d: any) => d.id)
                        )
                      });
                    }}
                  >
                    {imp.groups.map((x: any, i: number) => (
                      <option key={i} value={i}>
                        {x.materialModel || '未识别型号'}
                        {x.fabricCode ? ' · ' + x.fabricCode : ''} · {x.demands.length}{' '}
                        项{x.issues.length ? ' · ' + x.issues.length + ' 项待修正' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      setImp({
                        ...imp,
                        selected: new Set(curGroup.demands.map((d: any) => d.id))
                      })
                    }
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setImp({ ...imp, selected: new Set() })}
                  >
                    清空
                  </button>
                  <span className="muted">已选 {imp.selected.size} 项</span>
                  <span className="sp" />
                  <label className="muted">
                    <input
                      type="checkbox"
                      checked={imp.append}
                      onChange={(e) => setImp({ ...imp, append: e.target.checked })}
                    />{' '}
                    追加到现有需求
                  </label>
                  <button
                    type="button"
                    className="btn sm pri"
                    disabled={!(imp.selected.size > 0 && curGroup.index >= 0)}
                    onClick={handleApplyImport}
                  >
                    导入所选
                  </button>
                </div>
                <div style={{ maxHeight: 240, overflow: 'auto' }}>
                  <table className="t" style={{ border: 0 }}>
                    <tbody>
                      {curGroup.demands.map((d: any) => (
                        <tr key={d.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={imp.selected.has(d.id)}
                              onChange={(e) => {
                                const next = new Set(imp.selected);
                                if (e.target.checked) next.add(d.id);
                                else next.delete(d.id);
                                setImp({ ...imp, selected: next });
                              }}
                            />
                          </td>
                          <td className="wrap">{d.name}</td>
                          <td className="r num">
                            {fmtN(d.width, 1)} × {fmtN(d.length, 1)}
                          </td>
                          <td className="r num">{d.quantity} 件</td>
                          <td className="muted">{d.note || ''}</td>
                        </tr>
                      ))}
                      {curGroup.issues.map((x: any, idx: number) => (
                        <tr key={`issue-${idx}`}>
                          <td />
                          <td
                            className="wrap"
                            colSpan={4}
                            style={{ color: 'var(--warn)' }}
                          >
                            第 {x.row} 行：{x.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(form.demands || []).length > 0 ? (
              <table className="t" style={{ border: 0 }}>
                <thead>
                  <tr>
                    <th className="r">编号</th>
                    <th>{isSlitting ? '订单 / 规格' : '名称'}</th>
                    <th className="r">{isSlitting ? '分切宽 mm' : '宽 mm'}</th>
                    <th className="r">{isSlitting ? '卷长 mm' : '长 mm'}</th>
                    <th className="r">{isSlitting ? '卷数' : '件数'}</th>
                    {!isSlitting && <th>可旋转</th>}
                    <th className="r">已报工</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {form.demands.map((d: any, i: number) => {
                    const l = lineLock(d, completed);
                    return (
                      <tr key={d.id || i}>
                        <td className="r num">{d.id}</td>
                        <td>
                          <input
                            className="field"
                            value={d.name || ''}
                            style={{ width: '100%', height: 22 }}
                            disabled={l.locked}
                            onChange={(e) =>
                              updateAndPersist({
                                ...form,
                                demands: form.demands.map((item: any, j: number) =>
                                  j === i ? { ...item, name: e.target.value } : item
                                )
                              })
                            }
                          />
                        </td>
                        <td className="r">
                          <input
                            type="number"
                            className="field num"
                            value={d.width}
                            style={{ width: 80, height: 22, textAlign: 'right' }}
                            disabled={Boolean(l.locked || d.shape)}
                            onChange={(e) =>
                              updateAndPersist({
                                ...form,
                                demands: form.demands.map((item: any, j: number) =>
                                  j === i
                                    ? { ...item, width: Number(e.target.value) }
                                    : item
                                )
                              })
                            }
                          />
                        </td>
                        <td className="r">
                          <input
                            type="number"
                            className="field num"
                            value={d.length}
                            style={{ width: 80, height: 22, textAlign: 'right' }}
                            disabled={Boolean(l.locked || d.shape)}
                            onChange={(e) =>
                              updateAndPersist({
                                ...form,
                                demands: form.demands.map((item: any, j: number) =>
                                  j === i
                                    ? { ...item, length: Number(e.target.value) }
                                    : item
                                )
                              })
                            }
                          />
                        </td>
                        <td className="r">
                          <input
                            type="number"
                            className="field num"
                            value={d.quantity}
                            style={{ width: 64, height: 22, textAlign: 'right' }}
                            title={
                              l.locked ? `不得少于已报工 ${l.minQuantity} 件` : ''
                            }
                            onChange={(e) =>
                              updateAndPersist({
                                ...form,
                                demands: form.demands.map((item: any, j: number) =>
                                  j === i
                                    ? {
                                        ...item,
                                        quantity: Math.round(Number(e.target.value))
                                      }
                                    : item
                                )
                              })
                            }
                          />
                        </td>
                        {!isSlitting && (
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(d.allowRotation)}
                              onChange={(e) =>
                                updateAndPersist({
                                  ...form,
                                  demands: form.demands.map((item: any, j: number) =>
                                    j === i
                                      ? { ...item, allowRotation: e.target.checked }
                                      : item
                                  )
                                })
                              }
                            />
                          </td>
                        )}
                        <td className="r num">
                          {completed[d.id] || completed[String(d.id)] || 0}
                        </td>
                        <td>
                          {l.locked ? (
                            <span className="tag">已报工</span>
                          ) : (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() =>
                                updateAndPersist({
                                  ...form,
                                  demands: form.demands.filter(
                                    (_: any, j: number) => j !== i
                                  )
                                })
                              }
                            >
                              删除
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                还没有需求。添加需求，或导入订单表（9.28 订单格式 / 标准模板 / 任务 JSON / DXF）。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
