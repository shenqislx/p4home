#pragma once

/* The pixel simulator is intentionally single threaded. Compile the real
 * conversation_service implementation so its public contract and state
 * semantics cannot drift, while replacing only the FreeRTOS mutex primitive
 * that is unavailable on the host. Concurrency remains a hardware concern. */

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t initialized;
} sim_semaphore_t;

typedef sim_semaphore_t *SemaphoreHandle_t;

#ifndef pdTRUE
#define pdTRUE 1
#endif

#ifndef pdFALSE
#define pdFALSE 0
#endif

static inline SemaphoreHandle_t xSemaphoreCreateMutex(void)
{
    static sim_semaphore_t mutex = {.initialized = 1U};
    return &mutex;
}

static inline int xSemaphoreTake(SemaphoreHandle_t mutex, uint32_t ticks_to_wait)
{
    (void)ticks_to_wait;
    return mutex != NULL && mutex->initialized != 0U ? pdTRUE : pdFALSE;
}

static inline int xSemaphoreGive(SemaphoreHandle_t mutex)
{
    return mutex != NULL && mutex->initialized != 0U ? pdTRUE : pdFALSE;
}
