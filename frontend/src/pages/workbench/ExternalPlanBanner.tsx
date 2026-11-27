import React from 'react';
import { formatDraftMaterialType, getDraftStatusMeta, type WorkbenchDraftDto } from './draftInboxApi';
import type { ExternalPlanBannerMeta } from './workbenchDeeplinkUtils';

export interface ExternalPlanBannerProps {
  loading?: boolean;
  error?: string | null;
  banner: ExternalPlanBannerMeta | null;
  confirmedSchemeId?: string | null;
  siblingDrafts?: WorkbenchDraftDto[];
  onSelectDraft?: (draft: WorkbenchDraftDto) => void;
  onDiscardDraft?: (draftId: string) => void;
  onDismiss: () => void;
}

function formatExpireTime(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 外部 Harness / 深链一键接管工作台时的工业风顶部预览横幅。
 * 严守“预览态不锁库、实绩落库走既有确认流”的账实分离原则，支持浅/暗双主题 CSS Token。
 */
export const ExternalPlanBanner: React.FC<ExternalPlanBannerProps> = ({
  loading = false,
  error = null,
  banner,
  confirmedSchemeId = null,
  siblingDrafts = [],
  onSelectDraft,
  onDiscardDraft,
  onDismiss
}) => {
  if (!loading && !error && !banner) return null;

  if (loading && !banner && !error) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="正在载入外部试排方案"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 14px',
          fontSize: 12.5,
          background: 'var(--run-bg, rgba(2, 132, 199, 0.1))',
          borderBottom: '1px solid var(--line-2, rgba(148, 163, 184, 0.35))',
          borderLeft: '3px solid var(--run, #0284c7)',
          color: 'var(--cp-ink, #0f172a)'
        }}
      >
        <span className="tag run">深链接管中</span>
        <span>正在加载外部试排结果与草案核对上下文…</span>
      </div>
    );
  }

  if (error && !banner) {
    return (
      <div
        role="alert"
        aria-label="外部试排方案加载失败"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '8px 14px',
          fontSize: 12.5,
          background: 'var(--err-bg, rgba(220, 38, 38, 0.12))',
          borderBottom: '1px solid var(--err, #dc2626)',
          borderLeft: '3px solid var(--err, #dc2626)',
          color: 'var(--cp-ink, #0f172a)'
        }}
      >
        <span className="tag err">外部方案加载失败</span>
        <span style={{ color: 'var(--err, #b91c1c)', fontWeight: 500 }}>{error}</span>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={onDismiss}>
          关闭提示
        </button>
      </div>
    );
  }

  if (!banner) return null;

  const effectiveConfirmedId = confirmedSchemeId || banner.confirmedSchemeId;
  const isConfirmed = Boolean(effectiveConfirmedId) || banner.status === 'CONFIRMED';
  const isDiscarded = !isConfirmed && banner.status === 'DISCARDED';
  const isExpiredByTime = Boolean(
    banner.expiresAt &&
      Number.isFinite(Date.parse(banner.expiresAt)) &&
      Date.parse(banner.expiresAt) < Date.now()
  );
  const isExpired =
    !isConfirmed &&
    !isDiscarded &&
    (Boolean(banner.expired) || banner.status === 'EXPIRED' || isExpiredByTime);
  const isStaleOrExpired = !isConfirmed && !isDiscarded && (banner.stale || isExpired);
  const hasFailedChecks = !isConfirmed && !isDiscarded && banner.failedRiskChecks.length > 0;
  const hasPartialFulfillment = !isConfirmed && !isDiscarded && banner.fulfillmentStatus !== 'COMPLETE';

  const accentColor = isConfirmed
    ? 'var(--ok, #059669)'
    : isDiscarded || isStaleOrExpired
    ? 'var(--err, #dc2626)'
    : hasFailedChecks || hasPartialFulfillment
    ? 'var(--warn, #d97706)'
    : 'var(--run, #0284c7)';

  const surfaceBg = isConfirmed
    ? 'var(--ok-bg, rgba(16, 185, 129, 0.12))'
    : isDiscarded || isStaleOrExpired
    ? 'var(--err-bg, rgba(220, 38, 38, 0.1))'
    : hasFailedChecks
    ? 'var(--warn-bg, rgba(245, 158, 11, 0.12))'
    : 'var(--panel-2, rgba(2, 132, 199, 0.06))';

  const borderBottomColor = isDiscarded || isStaleOrExpired
    ? 'var(--err, #dc2626)'
    : hasFailedChecks
    ? 'var(--warn, #d97706)'
    : 'var(--line-2, rgba(148, 163, 184, 0.35))';

  const fulfillmentTagClass =
    banner.fulfillmentStatus === 'COMPLETE'
      ? 'ok'
      : banner.fulfillmentStatus === 'PARTIAL'
      ? 'warn'
      : 'err';

  const expiresAtText = formatExpireTime(banner.expiresAt);

  return (
    <section
      role={isDiscarded || isStaleOrExpired || Boolean(error) ? 'alert' : 'status'}
      aria-label="外部试排方案预览提示"
      data-testid="external-plan-banner"
      style={{
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 14px',
        fontSize: 12,
        background: surfaceBg,
        borderBottom: `1px solid ${borderBottomColor}`,
        borderLeft: `3px solid ${accentColor}`,
        color: 'var(--cp-ink, #0f172a)'
      }}
    >
      {/* 主信息行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8
        }}
      >
        <strong style={{ fontSize: 12.5, fontWeight: 650 }}>
          {isConfirmed
            ? `外部试排方案已正式落库${effectiveConfirmedId ? `（${effectiveConfirmedId}）` : ''}`
            : isDiscarded
            ? '外部试排草案已作废（不可确认落库）'
            : '外部试排方案预览（尚未锁库）'}
        </strong>

        {isDiscarded && <span className="tag err">已作废</span>}
        {isExpired && <span className="tag err">草案已过期</span>}
        {!isConfirmed && !isDiscarded && !isExpired && banner.stale && (
          <span className="tag err">库存/需求版本已变化</span>
        )}
        {!isConfirmed && !isDiscarded && !isExpired && !banner.stale && banner.draftId && (
          <span className="tag run">待人工确认草案</span>
        )}
        {!isConfirmed && !isDiscarded && !isExpired && !banner.draftId && <span className="tag kind">只读预览</span>}

        <span className={`tag ${fulfillmentTagClass}`}>{banner.fulfillmentLabel}</span>

        <span className="num" style={{ color: 'var(--cp-ink-2, #475569)' }}>
          结果号 <b style={{ color: 'var(--cp-ink, #0f172a)' }}>{banner.resultId}</b>
        </span>

        {banner.draftId && (
          <span className="num" style={{ color: 'var(--cp-ink-2, #475569)' }}>
            草案号 <b style={{ color: 'var(--cp-ink, #0f172a)' }}>{banner.draftId}</b>
          </span>
        )}

        <span className="num" style={{ color: 'var(--cp-ink-2, #475569)' }}>
          {banner.materialLabel}
        </span>

        {expiresAtText && !isConfirmed && !isDiscarded && (
          <span className="num" style={{ color: 'var(--cp-ink-3, #64748b)' }}>
            有效期至 {expiresAtText}
          </span>
        )}

        <span className="sp" />

        {!isConfirmed && !isDiscarded && !isExpired && banner.draftId && onDiscardDraft && (
          <button
            type="button"
            className="btn sm err"
            onClick={() => onDiscardDraft(banner.draftId!)}
          >
            作废草案
          </button>
        )}

        <button type="button" className="btn sm" onClick={onDismiss}>
          关闭提示
        </button>
      </div>

      {/* 已作废说明条 */}
      {isDiscarded && (
        <div
          role="alert"
          data-testid="external-plan-discarded-alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            padding: '5px 9px',
            borderRadius: 4,
            background: 'var(--err-bg, rgba(220, 38, 38, 0.14))',
            border: '1px solid var(--err, #dc2626)',
            color: 'var(--err, #b91c1c)',
            fontSize: 12,
            fontWeight: 550
          }}
        >
          <span>
            该草案已人工确认作废（仅关闭建议，未扣减库存），禁止直接选定落库；如需继续排产请重新求解。
          </span>
          {banner.discardReason && (
            <span className="num" style={{ fontWeight: 400, color: 'var(--cp-ink, #0f172a)' }}>
              作废原因：{banner.discardReason}
            </span>
          )}
        </div>
      )}

      {/* 草案过期或库存/需求版本漂移告警条 */}
      {isStaleOrExpired && (
        <div
          role="alert"
          data-testid="external-plan-stale-alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            padding: '5px 9px',
            borderRadius: 4,
            background: 'var(--warn-bg, rgba(245, 158, 11, 0.16))',
            border: '1px solid var(--err, #dc2626)',
            color: 'var(--err, #b91c1c)',
            fontSize: 12,
            fontWeight: 550
          }}
        >
          <span>
            {isExpired && banner.stale
              ? '告警：库存或需求版本已变化且草案已过期，建议重新试排后再确认落库。'
              : isExpired
              ? '告警：该草案已过期，建议重新试排以获取最新有效方案。'
              : '告警：库存或需求版本已变化，草案可能与现场实物不一致，建议重新试排。'}
          </span>
          {banner.staleReasons.length > 0 && (
            <span className="num" style={{ fontWeight: 400, color: 'var(--cp-ink, #0f172a)' }}>
              变更明细：{banner.staleReasons.join('；')}
            </span>
          )}
        </div>
      )}

      {/* 加载部分异常提示（例如草案已取到但排料图不可用） */}
      {error && (
        <div
          role="alert"
          style={{
            padding: '4px 8px',
            borderRadius: 4,
            background: 'var(--err-bg, rgba(220, 38, 38, 0.14))',
            color: 'var(--err, #b91c1c)',
            fontSize: 12
          }}
        >
          {error}
        </div>
      )}

      {/* 风险预检项列表 */}
      {banner.riskChecks.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6
          }}
          aria-label="草案风险预检结果"
        >
          <span style={{ color: 'var(--cp-ink-2, #475569)', fontWeight: 600 }}>风险预检：</span>
          {banner.riskChecks.map((chk) => (
            <span
              key={`${chk.code}-${chk.message}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
                borderRadius: 3,
                fontSize: 11.5,
                border: `1px solid ${
                  chk.passed
                    ? 'var(--line-2, rgba(148, 163, 184, 0.4))'
                    : 'var(--warn, #d97706)'
                }`,
                background: chk.passed
                  ? 'var(--panel, #ffffff)'
                  : 'var(--warn-bg, rgba(245, 158, 11, 0.14))',
                color: chk.passed ? 'var(--cp-ink-2, #475569)' : 'var(--warn, #92400e)'
              }}
            >
              <b className="num" style={{ color: chk.passed ? 'var(--ok, #059669)' : 'var(--err, #dc2626)' }}>
                [{chk.passed ? '通过' : '告警'}]
              </b>
              <span>{chk.message}</span>
            </span>
          ))}
        </div>
      )}

      {/* 备注与人工核对闭环引导 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          color: 'var(--cp-ink-2, #475569)',
          fontSize: 11.5
        }}
      >
        {banner.note && (
          <span>
            备注：<b style={{ color: 'var(--cp-ink, #0f172a)', fontWeight: 550 }}>{banner.note}</b>
          </span>
        )}
        <span>
          {isConfirmed
            ? '当前方案已完成正式确认并同步需求履约进度，可在右侧或结果管理页查看工单。'
            : isDiscarded || isExpired
            ? '当前草案不可再作为有效确认依据，请点击工作台重新试排或从收件箱切换其他待确认草案。'
            : '请核对画布排布、避疵禁区与尺寸无误后，点击右侧「选定此方案」按钮完成正式确认落库（预览不会扣减库存）。'}
        </span>
      </div>

      {/* 同批组多料联排草案快捷切换条 */}
      {siblingDrafts.length > 1 && onSelectDraft && (
        <div className="wb-banner-sibling-bar" aria-label="同批联排草案切换">
          <span className="num" style={{ fontWeight: 600 }}>
            同批联排草案（{siblingDrafts.length}）：
          </span>
          {siblingDrafts.map((sib, idx) => {
            const sibId = sib.draftId || sib.id;
            const current = sibId === banner.draftId;
            const meta = getDraftStatusMeta(sib.status, sib.stale);
            return (
              <button
                key={sibId}
                type="button"
                className={`btn sm ${current ? 'pri' : ''}`}
                onClick={() => onSelectDraft(sib)}
                data-testid={`banner-sibling-${sibId}`}
              >
                #{sib.batchIndex ?? idx + 1} · {formatDraftMaterialType(sib.target?.materialType)}
                {sib.target?.materialId ? ` ${sib.target.materialId}` : ''} · {meta.label}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};
