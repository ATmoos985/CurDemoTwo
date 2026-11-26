package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import static com.example.cutdemotwo.business.optimization.WorkbenchComparisonService.complete;

/** Selects and presents verified facts. Free-form model output is never a production recommendation. */
@Service
public class ComparisonQuestions {
    enum Topic { SHORTAGE, SAVING, SUMMARY, OTHER }
    public record Answer(String source, List<String> lines) {}

    private final ComparisonQuestionModel model;

    public ComparisonQuestions(ComparisonQuestionModel model) {
        this.model = model;
    }

    public Answer answer(WorkbenchComparison comparison, String question) {
        var selected = model.classify(question);
        Topic topic = selected.orElseGet(() -> localTopic(question));
        List<String> lines = new ArrayList<>();
        if (topic == Topic.SHORTAGE || topic == Topic.SUMMARY) {
            lines.add(shortages("A", comparison.left()));
            lines.add(shortages("B", comparison.right()));
        }
        if (topic == Topic.SUMMARY && comparison.sameConstraints()) {
            boolean leftComplete = complete(comparison.left());
            boolean rightComplete = complete(comparison.right());
            if (leftComplete != rightComplete) {
                lines.add("本次要求齐套时，可选方案 " + (leftComplete ? "A" : "B") + "。");
            } else if (!leftComplete) {
                lines.add("本次要求齐套时，两案均需补排。");
            }
        }
        if (topic == Topic.SAVING || topic == Topic.SUMMARY) {
            var length = comparison.lengthComparison();
            if ("COMPARABLE".equals(length.status()) && length.savedLengthMm() != null) {
                String shorter = comparison.left().resultId().equals(length.shorterResultId()) ? "A" : "B";
                lines.add(length.savedLengthMm() == 0 ? "两套方案的预计占用长度相同。"
                        : "方案 " + shorter + " 预计节省 " + decimal(length.savedLengthMm()) + " mm。");
            } else {
                lines.add("当前无法判定哪套更省布。" + length.reason());
            }
        }
        if (topic == Topic.OTHER) {
            lines.add("可以问这两个方案各缺哪些裁片、预计省多少布，或该怎样选择。");
        }
        return new Answer(selected.isPresent() ? "LOCAL_MODEL" : "RULES", List.copyOf(lines));
    }

    static Topic localTopic(String question) {
        String q = question.toLowerCase(Locale.ROOT);
        boolean shortage = q.matches("(?s).*(缺|齐套|少排|未排|漏|没排|不足|shortage|missing).*");
        boolean length = q.matches("(?s).*(省|布长|版长|占长|长度|耗布|用布|可比|能比|可比较|不能比|saving|fabric).*");
        if ((shortage && length) || q.matches("(?s).*(选|推荐|差别|对比|比较|区别|哪个好|哪套好|总结|summary).*")) return Topic.SUMMARY;
        if (shortage) return Topic.SHORTAGE;
        if (length) return Topic.SAVING;
        return Topic.OTHER;
    }

    private static String shortages(String label, WorkbenchComparison.Side side) {
        var missing = side.demands().stream().filter(d -> d.unplaced() > 0).toList();
        if (missing.isEmpty()) return "方案 " + label + (complete(side)
                ? " 本次应排裁片已齐套。" : " 的归档结果尚未确认齐套。");
        var items = missing.stream().limit(8)
                .map(d -> d.name() + "（#" + d.demandId() + "）缺 " + d.unplaced() + " 片").toList();
        String rest = missing.size() > items.size() ? "，其余 " + (missing.size() - items.size()) + " 项见明细表" : "";
        return "方案 " + label + " 共缺 " + side.unplaced() + " 片，" + String.join("、", items) + rest + "。";
    }

    private static String decimal(double n) {
        return BigDecimal.valueOf(n).stripTrailingZeros().toPlainString();
    }

}
