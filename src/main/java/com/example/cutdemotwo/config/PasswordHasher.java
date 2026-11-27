package com.example.cutdemotwo.config;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 密码加盐哈希工具：使用 PBKDF2WithHmacSHA256（16 字节随机盐 + 120,000 次迭代 + 256-bit 派生密钥），
 * 存储格式为 {@code pbkdf2_sha256$120000$<base64urlSalt>$<base64urlHash>}，校验采用常量时间比对。
 */
public final class PasswordHasher {
    private static final String PREFIX = "pbkdf2_sha256";
    private static final String ALGORITHM = "PBKDF2WithHmacSHA256";
    private static final int DEFAULT_ITERATIONS = 120_000;
    private static final int SALT_BYTES = 16;
    private static final int KEY_BITS = 256;
    private static final SecureRandom RANDOM = new SecureRandom();

    private PasswordHasher() {}

    public static String hash(String rawPassword) {
        if (rawPassword == null || rawPassword.isEmpty()) {
            throw new IllegalArgumentException("密码不能为空");
        }
        byte[] salt = new byte[SALT_BYTES];
        RANDOM.nextBytes(salt);
        byte[] derived = pbkdf2(rawPassword.toCharArray(), salt, DEFAULT_ITERATIONS, KEY_BITS);
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        return PREFIX + "$" + DEFAULT_ITERATIONS + "$"
                + encoder.encodeToString(salt) + "$"
                + encoder.encodeToString(derived);
    }

    public static boolean matches(String rawPassword, String storedHash) {
        if (rawPassword == null || rawPassword.isEmpty() || storedHash == null || storedHash.isBlank()) {
            return false;
        }
        String[] parts = storedHash.split("\\$");
        if (parts.length != 4 || !PREFIX.equals(parts[0])) {
            return false;
        }
        int iterations;
        byte[] salt;
        byte[] expected;
        try {
            iterations = Integer.parseInt(parts[1]);
            if (iterations < 10_000 || iterations > 2_000_000) {
                return false;
            }
            Base64.Decoder decoder = Base64.getUrlDecoder();
            salt = decoder.decode(parts[2]);
            expected = decoder.decode(parts[3]);
        } catch (IllegalArgumentException invalid) {
            return false;
        }
        if (salt.length < 8 || expected.length < 16) {
            return false;
        }
        byte[] actual = pbkdf2(rawPassword.toCharArray(), salt, iterations, expected.length * 8);
        return MessageDigest.isEqual(expected, actual);
    }

    private static byte[] pbkdf2(char[] password, byte[] salt, int iterations, int keyBits) {
        PBEKeySpec spec = new PBEKeySpec(password, salt, iterations, keyBits);
        try {
            SecretKeyFactory factory = SecretKeyFactory.getInstance(ALGORITHM);
            return factory.generateSecret(spec).getEncoded();
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("PBKDF2 密码哈希计算失败", error);
        } finally {
            spec.clearPassword();
        }
    }
}
