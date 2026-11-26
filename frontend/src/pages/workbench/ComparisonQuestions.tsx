import { useState, type FormEvent } from 'react';
import { requestJSON } from '../../lib/core/util.js';

type Answer = { source: 'LOCAL_MODEL' | 'RULES'; lines: string[] };

export function ComparisonQuestions({ taskId, leftId, rightId }: {
  taskId?: string | null;
  leftId: string;
  rightId: string;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!taskId || loading || !question.trim()) return;
    setLoading(true);
    setAnswer(null);
    setError('');
    try {
      const result = await requestJSON(
        `/api/v2/workbench/tasks/${encodeURIComponent(taskId)}/comparison-questions`,
        { leftId, rightId, question: question.trim() }
      );
      setAnswer(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法回答，请重试。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="wb-comparison-questions">
      <summary>追问这两个方案</summary>
      <form onSubmit={ask}>
        <label htmlFor="wb-comparison-question">关于齐套、缺件或省布的问题</label>
        <div>
          <input id="wb-comparison-question" value={question} maxLength={240} disabled={loading}
            placeholder="例如：这单要求齐套，该选哪套？" onChange={e => setQuestion(e.target.value)} />
          <button type="submit" className="btn" disabled={loading || !taskId || !question.trim()}>
            {loading ? '查询中…' : '提问'}
          </button>
        </div>
      </form>
      <div role="status" aria-live="polite">
        {error && <p>{error}</p>}
        {answer && <>
          <small>{answer.source === 'LOCAL_MODEL' ? '本机模型识别问题 · 归档事实' : '归档事实答复'}</small>
          {answer.lines.map((line, index) => <p key={index}>{line}</p>)}
        </>}
      </div>
    </details>
  );
}

export default ComparisonQuestions;
