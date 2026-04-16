#include "unity.h"

void test_placeholder(void);

void app_main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_placeholder);
    UNITY_END();
}

void test_placeholder(void)
{
    TEST_ASSERT_TRUE(true);
}
