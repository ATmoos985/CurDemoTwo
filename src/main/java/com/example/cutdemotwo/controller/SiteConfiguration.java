package com.example.cutdemotwo.controller;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** 根路径显示介绍页；通用操作台固定在 /index.html，不再占用根路径。新版界面挂在 /app/。 */
@Configuration
public class SiteConfiguration implements WebMvcConfigurer {
    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        registry.addViewController("/").setViewName("forward:/intro.html");
        registry.addRedirectViewController("/app", "/app/");
        registry.addViewController("/app/").setViewName("forward:/app/index.html");
    }
}
