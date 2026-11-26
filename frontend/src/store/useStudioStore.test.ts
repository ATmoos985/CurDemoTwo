import { describe, expect, it } from 'vitest';
import { useStudioStore, type DemandFamilySummary } from './useStudioStore';

const makeFamily2D = (id: string, name: string, open1: number, open2: number): DemandFamilySummary => ({
  id,
  name,
  materialModel: 'MAT-2D',
  dimension: 'RECT_2D',
  revision: 1,
  orderedTotal: open1 + open2,
  plannedTotal: 0,
  completedTotal: 0,
  openTotal: open1 + open2,
  schemeCount: 0,
  status: 'OPEN',
  lines: [
    { id: 1, name: '主片', width: 600, length: 900, orderedQty: open1, plannedQty: 0, completedQty: 0, openQty: open1, allowRotation: true },
    { id: 2, name: '辅片', width: 300, length: 400, orderedQty: open2, plannedQty: 0, completedQty: 0, openQty: open2, allowRotation: false }
  ]
});

const makeFamily1D = (id: string, name: string, width: number, open: number): DemandFamilySummary => ({
  id,
  name,
  materialModel: 'FILM-4600',
  dimension: 'SLITTING_1D',
  revision: 1,
  orderedTotal: open,
  plannedTotal: 0,
  completedTotal: 0,
  openTotal: open,
  schemeCount: 0,
  status: 'OPEN',
  slitting: { leftTrim: 100, rightTrim: 100, minWidth: 4200, maxWidth: 4400, widthStep: 10, totalOverCap: 30 },
  lines: [
    { id: 7, name: `${width}mm宽条`, width, length: 2000, orderedQty: open, plannedQty: 0, completedQty: 0, openQty: open }
  ]
});

describe('useStudioStore 多族合排溯源保持与进度同步', () => {
  it('2D 多族合并载入工作台时在每个展开需求项保留 sourceTaskId 与 sourceLineId', () => {
    const famA = makeFamily2D('FAM-A', '订单A', 4, 2);
    const famB = makeFamily2D('FAM-B', '订单B', 3, 0);

    useStudioStore.getState().loadDemandFamiliesMergedIntoWorkbench([famA, famB]);
    const st = useStudioStore.getState();

    expect(st.activeDimension).toBe('2D');
    expect(st.loadedTaskId).toBeNull();
    expect(st.mergedSourceTaskIds).toEqual(['FAM-A', 'FAM-B']);
    expect(st.activeDemands2D).toHaveLength(3);
    expect(st.activeDemands2D[0]).toMatchObject({
      sourceTaskId: 'FAM-A',
      sourceTaskName: '订单A',
      sourceLineId: 1,
      quantity: 4
    });
    expect(st.activeDemands2D[1]).toMatchObject({
      sourceTaskId: 'FAM-A',
      sourceTaskName: '订单A',
      sourceLineId: 2,
      quantity: 2
    });
    expect(st.activeDemands2D[2]).toMatchObject({
      sourceTaskId: 'FAM-B',
      sourceTaskName: '订单B',
      sourceLineId: 1,
      quantity: 3
    });

    // 确认后多族进度刷新同步扣减各原行余量
    useStudioStore.getState().syncMergedDemandFamiliesProgress([
      {
        ...famA,
        plannedTotal: 2,
        openTotal: 4,
        lines: [
          { ...famA.lines[0], plannedQty: 2, openQty: 2 },
          famA.lines[1]
        ]
      },
      {
        ...famB,
        plannedTotal: 3,
        openTotal: 0,
        lines: [
          { ...famB.lines[0], plannedQty: 3, openQty: 0 },
          famB.lines[1]
        ]
      }
    ]);
    const after = useStudioStore.getState();
    expect(after.activeDemands2D[0].quantity).toBe(2);
    expect(after.activeDemands2D[0].plannedQty).toBe(2);
    expect(after.activeDemands2D[2].quantity).toBe(0);
    expect(after.activeDemands2D[2].plannedQty).toBe(3);
  });

  it('1D 多族合并载入工作台时保留每条分切订单的 sourceTaskId 与 sourceLineId', () => {
    const f1 = makeFamily1D('SLIT-A', '光学膜甲', 1080, 10);
    const f2 = makeFamily1D('SLIT-B', '光学膜乙', 920, 12);

    useStudioStore.getState().loadDemandFamiliesMergedIntoWorkbench([f1, f2]);
    const st = useStudioStore.getState();

    expect(st.activeDimension).toBe('1D');
    expect(st.slitLoadedTaskId).toBeNull();
    expect(st.slitMergedSourceTaskIds).toEqual(['SLIT-A', 'SLIT-B']);
    expect(st.slitOrders).toHaveLength(2);
    expect(st.slitOrders[0]).toMatchObject({
      sourceTaskId: 'SLIT-A',
      sourceTaskName: '光学膜甲',
      sourceLineId: 7,
      quantity: 10
    });
    expect(st.slitOrders[1]).toMatchObject({
      sourceTaskId: 'SLIT-B',
      sourceTaskName: '光学膜乙',
      sourceLineId: 7,
      quantity: 12
    });
  });
});
