package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.model.IntegrationProgress;
import java.util.function.Function;

public interface IntegrationDeliveryStore extends AutoCloseable {
    record Change<T>(IntegrationProgress progress,T result) {}
    <T> T update(String consumer,Function<IntegrationProgress,Change<T>> command);
    IntegrationProgress read(String consumer);
    long now();
    @Override default void close() {}
}
