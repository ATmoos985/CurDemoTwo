import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  expandClusterToDemands,
  useDemandPoolStore,
  useStudioSettings,
  useTemplateCatalogStore
} from '../store/selectors';
import type {
  DemandFamilySummary,
  Scenario1DType,
  Scenario2DType,
  WorkbenchLaunchPreset
} from '../store/studioTypes';
import { requestJSON, toast, fmtM } from '../lib/core/util.js';
import { parseDemandJSON, importGroups } from '../lib/domain/demand-import-model.js';
import { DxfImportWizardModal, ParsedDxfResult } from '../components/DxfImportWizardModal';
import { AuthSession } from '../utils/authClient';
import {
  DimensionKey,
  DraftLine,
  ParsedFileContext,
  createDefaultDraftLines,
  estimatePolygonArea
} from './demand/demandCreateTypes';
import { DemandBasicInfoSection } from './demand/DemandBasicInfoSection';
import { DemandPreScheduleSection } from './demand/DemandPreScheduleSection';
import { DemandSpecResultPanel } from './demand/DemandSpecResultPanel';
import { DemandImportWizardModal } from './demand/DemandImportWizardModal';
import '../styles/theme-demand-create.css';

export const DemandCreatePage: React.FC<{
  appendTaskId?: string;
  auth?: AuthSession;
}> = ({ appendTaskId, auth: _auth }) => {
  const { clusters, syncTemplatesFromServer } = useTemplateCatalogStore();
  const settings = useStudioSettings();
  const { loadDemandFamilyIntoWorkbench } = useDemandPoolStore();

  const [families, setFamilies] = useState<DemandFamilySummary[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);

  const [createDim, setCreateDim] = useState<DimensionKey>('RECT_2D');
  const [mergeTargetId, setMergeTargetId] = useState<string>(appendTaskId || '');
  const [familyName, setFamilyName] = useState('');
  const [materialModel, setMaterialModel] = useState('TC涤棉-B2026');
  const [externalRef, setExternalRef] = useState('');
  const [priority, setPriority] = useState<'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [dueDate, setDueDate] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [kittingGroup, setKittingGroup] = useState('');
  const [requiredBatchNo, setRequiredBatchNo] = useState('');
  const [requiredColor, setRequiredColor] = useState('');
  const [strictBatchMatch, setStrictBatchMatch] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [shiftTeam, setShiftTeam] = useState('');
  const [templateQuickId, setTemplateQuickId] = useState('');
  const [templateQuickSets, setTemplateQuickSets] = useState(2);
  const [draftLines, setDraftLines] = useState<DraftLine[]>(createDefaultDraftLines);
  const [isPristineDraft, setIsPristineDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [isDragOver, setIsDragOver] = useState(false);
  const [parsedFile, setParsedFile] = useState<ParsedFileContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 高级表格导入向导 & DXF 向导状态
  const [importWizardOpen, setImportWizardOpen] = useState(false);
  const [importInitialFile, setImportInitialFile] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);
  const [dxfWizardOpen, setDxfWizardOpen] = useState(false);
  const [dxfInitialFile, setDxfInitialFile] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);

  const [canvasMode2D, setCanvasMode2D] = useState<'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT'>('FREE_CANVAS');
  const [motherWidth2D, setMotherWidth2D] = useState(1650);
  const [bedLength2D, setBedLength2D] = useState(3200);
  const [selectedRollId2D, setSelectedRollId2D] = useState('');
  const [selectedRemnantId2D, setSelectedRemnantId2D] = useState('');
  const [scenario2D, setScenario2D] = useState<Scenario2DType>('SHORTEN_KIT');
  const [pieceGapMm, setPieceGapMm] = useState<number>(settings.pieceGapMm ?? 0);
  const [trimStartMm, setTrimStartMm] = useState<number>(settings.trimStartMm ?? 0);

  const [slitMode1D, setSlitMode1D] = useState<'VIRTUAL_ROLL' | 'STOCK_ROLL'>('VIRTUAL_ROLL');
  const [motherWidth1D, setMotherWidth1D] = useState(4600);
  const [fixedLen1D, setFixedLen1D] = useState(1350000);
  const [selectedRollId1D, setSelectedRollId1D] = useState('');
  const [leftTrim1D, setLeftTrim1D] = useState(100);
  const [rightTrim1D, setRightTrim1D] = useState(100);
  const [minWidth1D, setMinWidth1D] = useState(4300);
  const [maxWidth1D, setMaxWidth1D] = useState(4400);
  const [widthStep1D, setWidthStep1D] = useState(10);
  const [overCap1D, setOverCap1D] = useState(20);
  const [scenario1D, setScenario1D] = useState<Scenario1DType>('MIN_CARS');

  useEffect(() => {
    syncTemplatesFromServer();
    Promise.all([
      requestJSON('/api/v2/demand-pool').catch(() => []),
      requestJSON('/api/v2/rolls').catch(() => []),
      requestJSON('/api/v2/remnants').catch(() => [])
    ]).then(([poolData, rollData, remData]) => {
      const fams = Array.isArray(poolData) ? poolData : [];
      const rList = Array.isArray(rollData) ? rollData : [];
      const rmList = Array.isArray(remData) ? remData : [];
      setFamilies(fams);
      setRolls(rList);
      setRemnants(rmList);

      const passed = rList.filter(
        (r: any) =>
          (r.inspectionStatus === 'PASSED' || r.inspectionStatus === 'APPROVED') &&
          Number(r.currentRemainingLength) > 0
      );
      if (passed.length) {
        setSelectedRollId2D((prev) => prev || passed[0].rollId);
        setSelectedRollId1D((prev) => prev || passed[0].rollId);
      }
      const availRem = rmList.filter((rm: any) => rm.status === 'AVAILABLE');
      if (availRem.length) {
        setSelectedRemnantId2D((prev) => prev || availRem[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (!appendTaskId) {
      setMergeTargetId('');
      return;
    }
    const target = families.find((f) => f.id === appendTaskId);
    setMergeTargetId(appendTaskId);
    if (target) {
      setCreateDim(target.dimension);
      setMaterialModel(target.materialModel);
    }
  }, [appendTaskId, families]);

  const passedRolls = useMemo(
    () =>
      rolls.filter(
        (r) =>
          (r.inspectionStatus === 'PASSED' || r.inspectionStatus === 'APPROVED') &&
          Number(r.currentRemainingLength) > 0
      ),
    [rolls]
  );

  const availableRemnants = useMemo(
    () => remnants.filter((rm) => rm.status === 'AVAILABLE'),
    [remnants]
  );

  const materialOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.rollModel && set.add(r.rollModel));
    clusters.forEach((c) => c.materialModel && set.add(c.materialModel));
    families.forEach((f) => f.materialModel && set.add(f.materialModel));
    return [...set].sort();
  }, [rolls, clusters, families]);

  const batchNoOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.batchNo && set.add(String(r.batchNo)));
    return [...set].sort();
  }, [rolls]);

  const colorOptions = useMemo(() => {
    const set = new Set<string>();
    rolls.forEach((r) => r?.color && set.add(String(r.color)));
    return [...set].sort();
  }, [rolls]);

  const mergeTargetFamily = useMemo(
    () => families.find((f) => f.id === mergeTargetId) || null,
    [families, mergeTargetId]
  );

  const is1D = createDim === 'SLITTING_1D';

  const effectiveTargetWidthMm = useMemo(() => {
    if (is1D) {
      const r = passedRolls.find((x) => x.rollId === selectedRollId1D);
      const rawW = slitMode1D === 'STOCK_ROLL' && r ? Number(r.width) : motherWidth1D;
      return Math.max(100, rawW - leftTrim1D - rightTrim1D);
    }
    if (canvasMode2D === 'STOCK_ROLL') {
      const r = passedRolls.find((x) => x.rollId === selectedRollId2D);
      return Number(r?.width) || motherWidth2D;
    }
    if (canvasMode2D === 'REMNANT') {
      const rm = availableRemnants.find((x) => x.id === selectedRemnantId2D);
      return Number(rm?.width) || motherWidth2D;
    }
    return motherWidth2D;
  }, [
    is1D,
    slitMode1D,
    selectedRollId1D,
    motherWidth1D,
    leftTrim1D,
    rightTrim1D,
    canvasMode2D,
    selectedRollId2D,
    selectedRemnantId2D,
    motherWidth2D,
    passedRolls,
    availableRemnants
  ]);

  const isLineOversize = (ln: DraftLine) => {
    const w = Number(ln.width) || 0;
    const l = Number(ln.length) || 0;
    if (w <= 0) return false;
    if (is1D) return w > effectiveTargetWidthMm;
    if (ln.allowRotation) return Math.min(w, l) > effectiveTargetWidthMm;
    return w > effectiveTargetWidthMm;
  };

  const draftStats = useMemo(() => {
    let validCount = 0;
    let totalQty = 0;
    let areaMm2 = 0;
    let oversizeCount = 0;
    for (const ln of draftLines) {
      const len = is1D ? fixedLen1D : Number(ln.length) || 0;
      const w = Number(ln.width) || 0;
      const q = Number(ln.quantity) || 0;
      if (q > 0 && w > 0 && len > 0) {
        validCount += 1;
        totalQty += q;
        const unitArea =
          !is1D && ln.shape?.type === 'POLYGON' && Array.isArray(ln.shape?.vertices)
            ? estimatePolygonArea(ln.shape.vertices) || w * len
            : w * len;
        areaMm2 += unitArea * q;
        if (isLineOversize(ln)) oversizeCount += 1;
      }
    }
    return { validCount, totalQty, areaM2: areaMm2 / 1_000_000, oversizeCount };
  }, [draftLines, is1D, fixedLen1D, effectiveTargetWidthMm]);

  const applyParsedGroup = (fileName: string, groups: any[], index: number) => {
    const grp = groups[index];
    if (!grp?.demands?.length) return;
    const hasPoly = grp.demands.some((d: any) => d.shape?.type === 'POLYGON');
    const inferredDim: DimensionKey =
      grp.dimension === 'SLITTING_1D'
        ? 'SLITTING_1D'
        : /\.dxf$/i.test(fileName) || hasPoly
        ? 'CONTOUR_2D'
        : 'RECT_2D';
    const mapped: DraftLine[] = grp.demands.map((d: any, idx: number) => ({
      name: d.name || `识别规格 #${idx + 1}`,
      width: Number(d.width) || 0,
      length: Number(d.length) || 0,
      quantity: Math.max(1, Number(d.quantity || d.demand) || 1),
      allowRotation: inferredDim !== 'SLITTING_1D' && Boolean(d.allowRotation),
      allowHalfTurn: inferredDim !== 'SLITTING_1D' && Boolean(d.allowHalfTurn),
      surfaceTreatment: d.surfaceTreatment || undefined,
      shape: d.shape || undefined
    }));
    if (inferredDim === 'SLITTING_1D' && mapped[0]?.length > 0) {
      setFixedLen1D(mapped[0].length);
    }
    setCreateDim(inferredDim);
    if (!mergeTargetId) {
      setFamilyName(
        groups.length > 1
          ? `${fileName.replace(/\.[^.]+$/, '')} · 组${index + 1}`
          : `${fileName.replace(/\.[^.]+$/, '')}`
      );
      if (grp.materialModel) setMaterialModel(grp.materialModel);
      setExternalRef(`文件识别: ${fileName}`);
    }
    setDraftLines(mapped);
    setIsPristineDraft(false);
    setParsedFile({ fileName, groups, groupIndex: index });
  };

  const processImportedFile = async (file: File) => {
    try {
      if (/\.json$/i.test(file.name)) {
        const parsed = parseDemandJSON(JSON.parse(await file.text()));
        const groups = importGroups(parsed).filter((g: any) => (g.demands || []).length > 0);
        if (!groups.length) throw new Error('JSON 中未解析到有效需求行');
        applyParsedGroup(file.name, groups, 0);
        toast(`已识别「${file.name}」：共 ${groups[0].demands.length} 项规格`);
        return;
      }
      const buf = await file.arrayBuffer();
      if (/\.dxf$/i.test(file.name)) {
        setDxfInitialFile({ name: file.name, buffer: buf });
        setDxfWizardOpen(true);
        return;
      }
      setImportInitialFile({ name: file.name, buffer: buf });
      setImportWizardOpen(true);
    } catch (err: any) {
      toast('文件识别失败：' + err.message, true);
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processImportedFile(file);
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await processImportedFile(file);
  };

  const handleConfirmDxfImport = (parsed: ParsedDxfResult, fileName: string) => {
    const groups = parsed.groups.filter((g) => g.demands.length > 0);
    if (groups.length > 0) {
      applyParsedGroup(fileName, groups, 0);
      toast(`已从 DXF 导入「${fileName}」：${groups[0].demands.length} 个裁片（单位 ${parsed.unit}）`);
    }
    setDxfWizardOpen(false);
  };

  const handleConfirmTableImport = (fileName: string, groups: any[]) => {
    applyParsedGroup(fileName, groups, 0);
    setImportWizardOpen(false);
    toast(
      `已写入「${fileName}」第 1 组（共 ${groups.length} 组，${groups[0].demands.length} 行；可在上方分组条切换其余分组）`
    );
  };

  const handleAppendFromTemplate = () => {
    const tpl = clusters.find((c) => c.id === templateQuickId);
    if (!tpl) return;
    const sz = tpl.availableSizes[0];
    const mult = Math.max(1, templateQuickSets);
    let added: DraftLine[] = [];

    if (tpl.dimension === '1D') {
      if (!mergeTargetId) {
        setCreateDim('SLITTING_1D');
        setMaterialModel(tpl.materialModel);
      }
      setMotherWidth1D(tpl.defaultWidthMm);
      setFixedLen1D(tpl.defaultLengthMm);
      added = tpl.pieces.map((p) => {
        const g = Object.values(p.sizes)[0];
        return {
          name: p.name,
          width: g.w,
          length: g.h,
          quantity: p.quantityPerUnit * mult,
          allowRotation: false,
          allowHalfTurn: false,
          sourceTemplateId: tpl.id
        };
      });
    } else {
      const expanded = expandClusterToDemands(tpl, { [sz]: mult }, 1);
      if (!mergeTargetId) {
        if (expanded.some((d) => d.shape?.type === 'POLYGON')) setCreateDim('CONTOUR_2D');
        setMaterialModel(tpl.materialModel);
        if (!familyName.trim()) setFamilyName(`${tpl.name} (${sz}×${mult})`);
      }
      setMotherWidth2D(tpl.defaultWidthMm);
      setBedLength2D(Math.max(1600, tpl.defaultLengthMm));
      added = expanded.map((it) => ({
        name: it.name,
        width: it.width,
        length: it.length,
        quantity: it.quantity,
        allowRotation: it.allowRotation,
        allowHalfTurn: it.allowHalfTurn,
        sizeLabel: it.sizeLabel,
        sourceTemplateId: tpl.id,
        shape: it.shape
      }));
    }

    setDraftLines((prev) => (isPristineDraft ? added : [...prev, ...added]));
    setIsPristineDraft(false);
    toast(`已从模板「${tpl.name}」展开填入 ${added.length} 项规格`);
  };

  const handleReset = () => {
    setFamilyName('');
    setExternalRef('');
    setPriority('NORMAL');
    setDueDate('');
    setCustomerName('');
    setKittingGroup('');
    setRequiredBatchNo('');
    setRequiredColor('');
    setStrictBatchMatch(false);
    setMachineId('');
    setShiftTeam('');
    setTemplateQuickId('');
    setTemplateQuickSets(2);
    setParsedFile(null);
    setDraftLines(createDefaultDraftLines());
    setIsPristineDraft(true);
    if (!mergeTargetId) {
      setCreateDim('RECT_2D');
      setMaterialModel('TC涤棉-B2026');
    }
    toast('已重置本次需求内容');
  };

  const buildLaunchPreset = (): WorkbenchLaunchPreset => {
    if (is1D) {
      const usable = Math.max(100, motherWidth1D - leftTrim1D - rightTrim1D);
      const effMax = Math.min(usable, Math.max(100, maxWidth1D));
      const effMin = Math.min(effMax, Math.max(100, minWidth1D));
      return {
        slitMaterialMode: slitMode1D,
        slitMotherWidthMm: motherWidth1D,
        slitLeftTrimMm: leftTrim1D,
        slitRightTrimMm: rightTrim1D,
        slitMinWidthMm: effMin,
        slitMaxWidthMm: effMax,
        slitWidthStepMm: Math.max(1, widthStep1D),
        slitWidthMode: effMin === effMax ? 'FIXED' : 'FLEXIBLE',
        slitFixedLengthMm: fixedLen1D,
        slitRollId: selectedRollId1D,
        slitOverCap: overCap1D,
        scenario1D
      };
    }
    return {
      canvasMode: canvasMode2D,
      canvasWidthMm: motherWidth2D,
      canvasLengthMm: bedLength2D,
      selectedRollId: selectedRollId2D,
      selectedRemnantId: selectedRemnantId2D,
      pieceGapMm,
      trimStartMm,
      scenario2D
    };
  };

  const persistFamily = async (goWorkbench: boolean) => {
    const valid = draftLines.filter(
      (d) => d.quantity > 0 && d.width > 0 && (is1D ? fixedLen1D > 0 : d.length > 0)
    );
    if (!valid.length || submitting) {
      toast('请至少保留 1 行有效尺寸与数量', true);
      return;
    }
    setSubmitting(true);
    try {
      const saved: DemandFamilySummary = await requestJSON('/api/v2/demand-pool', {
        mergeIntoTaskId: mergeTargetId || undefined,
        name: familyName.trim() || `${materialModel} · 排程需求`,
        materialModel: materialModel.trim() || 'STANDARD-MAT',
        externalRef: externalRef.trim() || undefined,
        dueDate: dueDate.trim() || undefined,
        priority,
        customerName: customerName.trim() || undefined,
        kittingGroup: kittingGroup.trim() || undefined,
        requiredBatchNo: requiredBatchNo.trim() || undefined,
        requiredColor: requiredColor.trim() || undefined,
        strictBatchMatch: Boolean(strictBatchMatch),
        machineId: machineId.trim() || undefined,
        shiftTeam: shiftTeam.trim() || undefined,
        dimension: createDim,
        bedLengthMm: is1D ? fixedLen1D : bedLength2D,
        minWidthMm: is1D
          ? Math.min(Math.max(100, motherWidth1D - leftTrim1D - rightTrim1D), Math.max(100, minWidth1D))
          : undefined,
        maxWidthMm: is1D
          ? Math.min(Math.max(200, motherWidth1D - leftTrim1D - rightTrim1D), Math.max(200, maxWidth1D))
          : motherWidth2D,
        widthStepMm: is1D ? Math.max(1, widthStep1D) : undefined,
        leftTrimMm: is1D ? leftTrim1D : 0,
        rightTrimMm: is1D ? rightTrim1D : 0,
        totalOverCap: is1D ? overCap1D : 0,
        pieceGapMm: is1D ? 0 : pieceGapMm,
        trimStartMm: is1D ? 0 : trimStartMm,
        demands: valid.map((d, idx) => ({
          id: idx + 1,
          name: d.name || `规格 #${idx + 1}`,
          width: Number(d.width),
          length: is1D ? fixedLen1D : Number(d.length),
          quantity: Number(d.quantity),
          allowRotation: !is1D && Boolean(d.allowRotation),
          allowHalfTurn: !is1D && Boolean(d.allowHalfTurn),
          sizeLabel: d.sizeLabel || undefined,
          sourceTemplateId: d.sourceTemplateId || undefined,
          surfaceTreatment: d.surfaceTreatment || undefined,
          shape: d.shape || undefined
        }))
      });

      if (goWorkbench) {
        loadDemandFamilyIntoWorkbench(saved, buildLaunchPreset());
        toast(`已建档「${saved.name}」并携带排程配置进入工作台`);
        location.hash = '#/workbench';
      } else {
        toast(
          mergeTargetId
            ? `已向「${saved.name}」追加规格，当前共 ${saved.orderedTotal} 件/卷`
            : `已保存「${saved.name}」至需求库`
        );
        setFamilies((prev) => [saved, ...prev.filter((x) => x.id !== saved.id)]);
        setMergeTargetId('');
        setFamilyName('');
        setExternalRef('');
        setParsedFile(null);
      }
    } catch (err: any) {
      toast('保存需求失败：' + err.message, true);
    } finally {
      setSubmitting(false);
    }
  };

  const unitLabel = is1D ? '卷' : createDim === 'CONTOUR_2D' ? '片' : '件';

  return (
    <div className="react-page">
      <form
        className="dc-page dc-create-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await persistFamily(true);
        }}
      >
        <div className="dc-top-head">
          <div className="dc-top-title">
            <h1>需求管理</h1>
            <span className="dc-top-sub">
              拖拽识别文件、核对本次裁片并预选母卷工艺，一步进入搭切工作台
            </span>
          </div>
          <div className="dc-top-links">
            <a className="mp-ghost-btn" href="#/demand-library">
              历史需求库 ({families.length}) →
            </a>
            <a className="mp-ghost-btn" href="#/clusters">
              需求模板库
            </a>
          </div>
        </div>

        <div className="dc-split">
          <section className="dc-pane" aria-label="文件识别与排程准备">
            <div className="dc-pane-body">
              <DemandBasicInfoSection
                mergeTargetId={mergeTargetId}
                mergeTargetFamily={mergeTargetFamily}
                onCancelMerge={() => {
                  setMergeTargetId('');
                  location.hash = '#/demands';
                }}
                isDragOver={isDragOver}
                onSetIsDragOver={setIsDragOver}
                fileInputRef={fileInputRef}
                onFileInputChange={handleFileInputChange}
                onDrop={handleDrop}
                parsedFile={parsedFile}
                onOpenImportWizard={() => {
                  setImportInitialFile(null);
                  setImportWizardOpen(true);
                }}
                onOpenDxfWizard={() => {
                  setDxfInitialFile(null);
                  setDxfWizardOpen(true);
                }}
                createDim={createDim}
                onSetCreateDim={setCreateDim}
                familyName={familyName}
                setFamilyName={setFamilyName}
                materialModel={materialModel}
                setMaterialModel={setMaterialModel}
                materialOptions={materialOptions}
                externalRef={externalRef}
                setExternalRef={setExternalRef}
                priority={priority}
                setPriority={setPriority}
                dueDate={dueDate}
                setDueDate={setDueDate}
                customerName={customerName}
                setCustomerName={setCustomerName}
                kittingGroup={kittingGroup}
                setKittingGroup={setKittingGroup}
                requiredBatchNo={requiredBatchNo}
                setRequiredBatchNo={setRequiredBatchNo}
                batchNoOptions={batchNoOptions}
                requiredColor={requiredColor}
                setRequiredColor={setRequiredColor}
                colorOptions={colorOptions}
                machineId={machineId}
                setMachineId={setMachineId}
                shiftTeam={shiftTeam}
                setShiftTeam={setShiftTeam}
                strictBatchMatch={strictBatchMatch}
                setStrictBatchMatch={setStrictBatchMatch}
                clusters={clusters}
                templateQuickId={templateQuickId}
                setTemplateQuickId={setTemplateQuickId}
                templateQuickSets={templateQuickSets}
                setTemplateQuickSets={setTemplateQuickSets}
                onAppendFromTemplate={handleAppendFromTemplate}
              />

              <DemandPreScheduleSection
                is1D={is1D}
                passedRolls={passedRolls}
                availableRemnants={availableRemnants}
                canvasMode2D={canvasMode2D}
                setCanvasMode2D={setCanvasMode2D}
                motherWidth2D={motherWidth2D}
                setMotherWidth2D={setMotherWidth2D}
                bedLength2D={bedLength2D}
                setBedLength2D={setBedLength2D}
                selectedRollId2D={selectedRollId2D}
                setSelectedRollId2D={setSelectedRollId2D}
                selectedRemnantId2D={selectedRemnantId2D}
                setSelectedRemnantId2D={setSelectedRemnantId2D}
                scenario2D={scenario2D}
                setScenario2D={setScenario2D}
                pieceGapMm={pieceGapMm}
                setPieceGapMm={setPieceGapMm}
                trimStartMm={trimStartMm}
                setTrimStartMm={setTrimStartMm}
                slitMode1D={slitMode1D}
                setSlitMode1D={setSlitMode1D}
                selectedRollId1D={selectedRollId1D}
                setSelectedRollId1D={setSelectedRollId1D}
                motherWidth1D={motherWidth1D}
                setMotherWidth1D={setMotherWidth1D}
                fixedLen1D={fixedLen1D}
                setFixedLen1D={setFixedLen1D}
                leftTrim1D={leftTrim1D}
                setLeftTrim1D={setLeftTrim1D}
                rightTrim1D={rightTrim1D}
                setRightTrim1D={setRightTrim1D}
                minWidth1D={minWidth1D}
                setMinWidth1D={setMinWidth1D}
                maxWidth1D={maxWidth1D}
                setMaxWidth1D={setMaxWidth1D}
                widthStep1D={widthStep1D}
                setWidthStep1D={setWidthStep1D}
                overCap1D={overCap1D}
                setOverCap1D={setOverCap1D}
                scenario1D={scenario1D}
                setScenario1D={setScenario1D}
              />
            </div>
          </section>

          <DemandSpecResultPanel
            draftStats={draftStats}
            unitLabel={unitLabel}
            effectiveTargetWidthMm={effectiveTargetWidthMm}
            is1D={is1D}
            fixedLen1D={fixedLen1D}
            parsedFile={parsedFile}
            onSelectGroup={applyParsedGroup}
            draftLines={draftLines}
            onSetDraftLines={setDraftLines}
            onMarkDirty={() => setIsPristineDraft(false)}
            isLineOversize={isLineOversize}
            onReset={handleReset}
            submitting={submitting}
            mergeTargetId={mergeTargetId}
            onSaveOnly={() => persistFamily(false)}
          />
        </div>
      </form>

      <DemandImportWizardModal
        open={importWizardOpen}
        initialFile={importInitialFile}
        onClose={() => setImportWizardOpen(false)}
        onConfirmImport={handleConfirmTableImport}
      />

      <DxfImportWizardModal
        open={dxfWizardOpen}
        initialFileName={dxfInitialFile?.name}
        initialBuffer={dxfInitialFile?.buffer}
        confirmLabel="确认导入到需求规格"
        onClose={() => setDxfWizardOpen(false)}
        onConfirm={handleConfirmDxfImport}
      />
    </div>
  );
};
