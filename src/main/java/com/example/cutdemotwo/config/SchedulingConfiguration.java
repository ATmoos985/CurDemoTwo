package com.example.cutdemotwo.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** 启用 Spring 定时调度（草案过期滚动清理等后台轻量任务，可通过配置关闭）。 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "cutdemo.scheduling.enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfiguration {
}
