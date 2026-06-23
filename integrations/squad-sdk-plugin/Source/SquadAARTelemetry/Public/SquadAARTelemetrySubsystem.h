// Copyright SquadAAR.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "SquadAARTelemetrySubsystem.generated.h"

/**
 * Drives all SquadAAR telemetry. Auto-instantiates once per game world and runs
 * only on the server (dedicated or listen). Three repeating timers plus an
 * actor-spawn hook produce the LogSquadStats: lines:
 *
 *   - fast timer  → PlayerPos (+ PlayerLook/PlayerState in CQB mode)
 *   - slow timer  → Tickets, CapZone, VehiclePos/VehicleComp
 *   - role timer  → PlayerRole (team/squad/role roster)
 *   - spawn hook  → Projectile, FobCreated/FobDestroyed, Deployable
 *
 * Configure via environment variables or command line (see LoadConfig()).
 */
UCLASS()
class SQUADAARTELEMETRY_API USquadAARTelemetrySubsystem : public UWorldSubsystem
{
    GENERATED_BODY()

public:
    virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
    virtual void OnWorldBeginPlay(UWorld& InWorld) override;
    virtual void Deinitialize() override;

private:
    // --- config (env / command line, with defaults) ---
    float PosIntervalSec = 0.2f;   // 5 Hz player positions for the map replay
    float SlowIntervalSec = 1.0f;  // tickets / cap zones / vehicles
    float RoleIntervalSec = 5.0f;  // roster (team/squad/role)
    bool  bEmitProjectiles = true; // projectile from/to for sightlines
    bool  bCQB = false;            // 30 Hz + PlayerLook/PlayerState for 1v1 coaching

    FTimerHandle PosTimer;
    FTimerHandle SlowTimer;
    FTimerHandle RoleTimer;
    FDelegateHandle SpawnHandle;

    struct FProjInfo
    {
        FVector From = FVector::ZeroVector;
        FString Weapon;
        FString ShooterEOS;
        double  SpawnTime = 0.0;
    };
    TMap<TWeakObjectPtr<AActor>, FProjInfo> Projectiles;

    void LoadConfig();

    // timer callbacks
    void TickPositions();
    void TickSlow();
    void TickRoles();

    // emitters
    void EmitPlayerPositions();
    void EmitRoles();
    void EmitTickets();
    void EmitCapZones();
    void EmitVehicles();

    // actor lifecycle hooks
    void HandleActorSpawned(AActor* Actor);

    UFUNCTION()
    void HandleProjectileDestroyed(AActor* DestroyedActor);

    UFUNCTION()
    void HandleFobDestroyed(AActor* DestroyedActor);
};
