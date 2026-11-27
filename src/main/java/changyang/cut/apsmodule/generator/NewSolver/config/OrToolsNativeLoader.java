package changyang.cut.apsmodule.generator.NewSolver.config;

import java.util.concurrent.locks.ReentrantLock;

import com.google.ortools.Loader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Thread-safe, idempotent native library loader for OR-Tools.
 */
public final class OrToolsNativeLoader {

    private static final Logger log = LoggerFactory.getLogger(OrToolsNativeLoader.class);
    private static final ReentrantLock LOAD_LOCK = new ReentrantLock();
    private static volatile boolean loaded;

    private OrToolsNativeLoader() {
    }

    public static boolean ensureLoaded() {
        return ensureLoaded(null);
    }

    public static boolean ensureLoaded(String caller) {
        if (loaded) {
            return true;
        }
        LOAD_LOCK.lock();
        try {
            if (loaded) {
                return true;
            }
            Loader.loadNativeLibraries();
            loaded = true;
            if (caller != null && !caller.isBlank()) {
                log.info("OR-Tools native libraries loaded ({})", caller);
            } else {
                log.info("OR-Tools native libraries loaded");
            }
            return true;
        } catch (Exception | LinkageError e) {
            if (caller != null && !caller.isBlank()) {
                log.warn("Failed to load OR-Tools native libraries ({}): {}", caller, e.getMessage());
            } else {
                log.error("Failed to load OR-Tools native libraries", e);
            }
            return false;
        } finally {
            LOAD_LOCK.unlock();
        }
    }
}
