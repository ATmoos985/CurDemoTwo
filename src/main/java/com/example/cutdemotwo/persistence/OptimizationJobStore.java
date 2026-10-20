package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import java.util.List;

public interface OptimizationJobStore extends AutoCloseable {
    List<StoredOptimizationJob> load();
    void save(StoredOptimizationJob document);
    @Override void close();
}
