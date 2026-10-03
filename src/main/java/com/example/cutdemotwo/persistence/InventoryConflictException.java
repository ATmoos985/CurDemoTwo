package com.example.cutdemotwo.persistence;

public class InventoryConflictException extends RuntimeException {
    public InventoryConflictException() { super("库存已被其他操作更新，请刷新后重试"); }
}
