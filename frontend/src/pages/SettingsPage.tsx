import React, { useEffect, useState } from 'react';
import { requestJSON, toast } from '@static/app/js/util.js';

export const SettingsPage: React.FC = () => {
  const [cap, setCap] = useState<any>(null);
  const [minW, setMinW] = useState(Number(localStorage.getItem('cam_min_rem_w') ?? 200));
  const [minL, setMinL] = useState(Number(localStorage.getItem('cam_min_rem_l') ?? 300));
  const [timeLimit, setTimeLimit] = useState(Number(localStorage.getItem('cam_timeout') ?? 5));

  const fetchCaps = () => {
    requestJSON('/api/v2/capabilities')
      .then((c) => setCap(c))
      .catch((e) => toast('读取并发能力失败：' + e.message, true));
  };

  useEffect(() => {
    fetchCaps();
  }, []);

  const saveParams = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('cam_min_rem_w', String(minW));
    localStorage.setItem('cam_min_rem_l', String(minL));
    localStorage.setItem('cam_timeout', String(timeLimit));
    toast('本地求解参数已保存');
  };

  return (
    <div className="react-page">
      <div className="ph">
        <h1>设置</h1>
        <span className="crumb">并发计算引擎状态与本机默认排料参数</span>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={fetchCaps}>
          刷新服务能力
        </button>
      </div>
      <div className="body" style={{ maxWidth: 880 }}>
        <div className="box">
          <div className="pane-h">求解引擎状态与并发配额</div>
          {cap ? (
            <>
              <div className="metric" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <div>
                  <small>并发求解工作线程</small>
                  <b className="num" style={{ color: 'var(--ok)' }}>
                    {cap.limits?.workers} <em>线程并发</em>
                  </b>
                </div>
                <div>
                  <small>等待队列容量</small>
                  <b className="num">
                    {cap.limits?.queueCapacity} <em>作业</em>
                  </b>
                </div>
                <div>
                  <small>异形最大裁片数</small>
                  <b className="num">{cap.limits?.maxContourPieces}</b>
                </div>
                <div>
                  <small>矩形最大裁片数</small>
                  <b className="num">{cap.limits?.maxPieces}</b>
                </div>
              </div>
              <table className="t" style={{ border: 0 }}>
                <thead>
                  <tr>
                    <th>求解器引擎 ID</th>
                    <th>状态</th>
                    <th>支持几何 / 工艺模式</th>
                    <th className="r">精度</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...(cap.engines || []),
                    ...(cap.slittingEngine
                      ? [
                          {
                            ...cap.slittingEngine,
                            shapes: ['定长条宽订单'],
                            modes: ['一维分切'],
                            coordinateResolutionMm: cap.slittingEngine.lengthResolutionMm
                          }
                        ]
                      : [])
                  ].map((e: any) => (
                    <tr key={e.id}>
                      <td className="num" style={{ fontWeight: 600 }}>{e.id}</td>
                      <td>
                        <span className={`tag ${e.available ? 'ok' : 'err'}`}>
                          {e.available ? '可用 (并行隔离进程)' : '未就绪'}
                        </span>
                      </td>
                      <td>{[...(e.modes || []), ...(e.shapes || [])].join(' · ')}</td>
                      <td className="r num">{e.coordinateResolutionMm} mm</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="loading">正在检测多线程池能力…</div>
          )}
        </div>

        <form className="box" onSubmit={saveParams}>
          <div className="pane-h">默认求解参数（本机存储）</div>
          <div className="form">
            <label>候选料头最小宽 mm</label>
            <input type="number" className="field num" value={minW} onChange={(e) => setMinW(Number(e.target.value))} />
            <label>候选料头最小长 mm</label>
            <input type="number" className="field num" value={minL} onChange={(e) => setMinL(Number(e.target.value))} />
            <label>单作业默认时限 (秒)</label>
            <input type="number" className="field num" value={timeLimit} onChange={(e) => setTimeLimit(Number(e.target.value))} />
          </div>
          <div className="foot">
            <span className="sp" />
            <button type="submit" className="btn pri">
              保存参数
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
