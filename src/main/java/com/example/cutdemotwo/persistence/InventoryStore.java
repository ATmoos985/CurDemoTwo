package com.example.cutdemotwo.persistence;

public interface InventoryStore {
    InventorySnapshot load();
    long save(InventorySnapshot snapshot);
    default boolean shared() { return false; }
    default long now() { return System.currentTimeMillis(); }
}
