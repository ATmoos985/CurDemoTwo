package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class FileOptimizationJobStoreTests {
    @TempDir Path directory;
    StoredOptimizationJob queued;
    StoredOptimizationJob running;

    @BeforeEach void persistOriginal() {
        var job = new OptimizationJob(UUID.randomUUID().toString(), "2.0", "req", "hash",
                "QUEUED", "QUEUED", "2026-01-01T00:00:00Z", null, null, 10, null, null, "queued");
        queued = new StoredOptimizationJob("test-snapshot", null, job, null);
        running = queued.transition("RUNNING", "SOLVING", null, "solving", null, 1);
        try (var store = new FileOptimizationJobStore(directory)) {
            store.save(queued);
        }
    }

    @Test void retriesDeniedReplacementOfTheSameFlushedSnapshot() throws Exception {
        var attempts = new AtomicInteger();
        var paths = new java.util.HashSet<Path>();
        try (var store = new FileOptimizationJobStore(directory, (source, target) -> {
            paths.add(source);
            if (attempts.incrementAndGet() <= 2) throw new AccessDeniedException(target.toString());
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        })) {
            store.save(running);
            assertEquals(List.of(running), store.load());
        }
        assertEquals(3, attempts.get());
        assertEquals(1, paths.size());
        assertFalse(Files.exists(paths.iterator().next()));
    }

    @Test void persistentDenialIsBoundedAndLeavesOnlyThePreviousSnapshot() throws Exception {
        var attempts = new AtomicInteger();
        try (var store = new FileOptimizationJobStore(directory, (source, target) -> {
            attempts.incrementAndGet();
            throw new AccessDeniedException(target.toString());
        })) {
            var error = assertThrows(IllegalStateException.class, () -> store.save(running));
            assertInstanceOf(AccessDeniedException.class, error.getCause());
            assertEquals(6, attempts.get());
            assertEquals(List.of(queued), store.load());
            try (var files = Files.newDirectoryStream(directory, "pending-*.tmp")) {
                assertFalse(files.iterator().hasNext());
            }
        }
    }

    @Test void unsupportedAtomicMoveFailsImmediatelyAndPreservesOriginal() {
        var attempts = new AtomicInteger();
        try (var store = new FileOptimizationJobStore(directory, (source, target) -> {
            attempts.incrementAndGet();
            throw new AtomicMoveNotSupportedException(source.toString(), target.toString(), "unsupported");
        })) {
            var error = assertThrows(IllegalStateException.class, () -> store.save(running));
            assertInstanceOf(AtomicMoveNotSupportedException.class, error.getCause());
            assertEquals(1, attempts.get());
            assertEquals(List.of(queued), store.load());
        }
    }

    @Test void interruptionStopsRetriesAndPreservesInterruptFlag() {
        var attempts = new AtomicInteger();
        try (var store = new FileOptimizationJobStore(directory, (source, target) -> {
            attempts.incrementAndGet();
            Thread.currentThread().interrupt();
            throw new AccessDeniedException(target.toString());
        })) {
            try {
                var error = assertThrows(IllegalStateException.class, () -> store.save(running));
                assertInstanceOf(AccessDeniedException.class, error.getCause());
                assertTrue(Thread.currentThread().isInterrupted());
                assertEquals(1, attempts.get());
            } finally {
                Thread.interrupted();
            }
            assertEquals(List.of(queued), store.load());
        }
    }
}
