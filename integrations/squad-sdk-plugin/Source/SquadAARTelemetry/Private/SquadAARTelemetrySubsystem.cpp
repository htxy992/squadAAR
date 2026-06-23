// Copyright SquadAAR.
#include "SquadAARTelemetrySubsystem.h"
#include "SquadAARTelemetryLog.h"
#include "SquadAARSDKBridge.h"

#include "Engine/World.h"
#include "Engine/GameInstance.h"
#include "GameFramework/GameStateBase.h"
#include "GameFramework/PlayerState.h"
#include "EngineUtils.h" // TActorIterator
#include "TimerManager.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

namespace
{
    /** Sanitize a string into the [\w.-]+ alphabet the parser's word fields use. */
    FString San(const FString& In)
    {
        FString Out;
        Out.Reserve(In.Len());
        for (const TCHAR c : In)
        {
            const bool bOk = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                             (c >= 'A' && c <= 'Z') || c == '_' || c == '.' || c == '-';
            Out.AppendChar(bOk ? c : '_');
        }
        return Out.IsEmpty() ? FString(TEXT("_")) : Out;
    }

    /** Plain decimal, no exponent/inf/nan — the number fields are -?[0-9.]+. */
    FString F1(double v)
    {
        if (!FMath::IsFinite(v)) v = 0.0;
        return FString::Printf(TEXT("%.1f"), v);
    }
    FString F3(double v)
    {
        if (!FMath::IsFinite(v)) v = 0.0;
        return FString::Printf(TEXT("%.3f"), v);
    }

    /** EOS hex of whoever caused this actor (player instigator), or "0". */
    FString InstigatorEOS(const AActor* A)
    {
        if (!A) return TEXT("0");
        if (const APawn* P = A->GetInstigator())
        {
            const FString Eos = SquadAARSDK::GetEOSId(P->GetPlayerState());
            if (!Eos.IsEmpty()) return Eos;
        }
        if (const AController* C = A->GetInstigatorController())
        {
            const FString Eos = SquadAARSDK::GetEOSId(C->PlayerState);
            if (!Eos.IsEmpty()) return Eos;
        }
        return TEXT("0");
    }

    int32 InstigatorTeam(const AActor* A)
    {
        if (!A) return 0;
        if (const APawn* P = A->GetInstigator())
            return SquadAARSDK::GetTeamId(P->GetPlayerState());
        if (const AController* C = A->GetInstigatorController())
            return SquadAARSDK::GetTeamId(C->PlayerState);
        return 0;
    }

    float EnvF(const TCHAR* Key, float Def)
    {
        const FString V = FPlatformMisc::GetEnvironmentVariable(Key);
        return V.IsEmpty() ? Def : FCString::Atof(*V);
    }
    bool EnvB(const TCHAR* Key, bool Def)
    {
        const FString V = FPlatformMisc::GetEnvironmentVariable(Key);
        if (V.IsEmpty()) return Def;
        return V == TEXT("1") || V.Equals(TEXT("true"), ESearchCase::IgnoreCase);
    }
}

bool USquadAARTelemetrySubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
    if (!Super::ShouldCreateSubsystem(Outer)) return false;
    // Only real game worlds (and PIE for local testing) — never editor previews.
    if (const UWorld* World = Cast<UWorld>(Outer))
        return World->WorldType == EWorldType::Game || World->WorldType == EWorldType::PIE;
    return false;
}

void USquadAARTelemetrySubsystem::LoadConfig()
{
    const float PosHz = FMath::Max(EnvF(TEXT("SQUADAAR_POS_HZ"), 5.0f), 0.1f);
    PosIntervalSec   = 1.0f / PosHz;
    SlowIntervalSec  = FMath::Max(EnvF(TEXT("SQUADAAR_SLOW_SEC"), 1.0f), 0.1f);
    RoleIntervalSec  = FMath::Max(EnvF(TEXT("SQUADAAR_ROLE_SEC"), 5.0f), 0.5f);
    bEmitProjectiles = EnvB(TEXT("SQUADAAR_PROJECTILES"), true);
    bCQB             = EnvB(TEXT("SQUADAAR_CQB"), false);

    // Command-line overrides win (e.g. -SquadAARPosHz=30 -SquadAARCQB=1).
    float CliHz = 0.f;
    if (FParse::Value(FCommandLine::Get(), TEXT("SquadAARPosHz="), CliHz) && CliHz > 0.f)
        PosIntervalSec = 1.0f / CliHz;
    if (FParse::Param(FCommandLine::Get(), TEXT("SquadAARCQB")))
        bCQB = true;

    if (bCQB)
    {
        // CQB coaching wants ~30 Hz unless the operator picked a higher rate.
        PosIntervalSec = FMath::Min(PosIntervalSec, 1.0f / 30.0f);
    }
}

void USquadAARTelemetrySubsystem::OnWorldBeginPlay(UWorld& InWorld)
{
    Super::OnWorldBeginPlay(InWorld);

    // Server only. Clients never produce authoritative telemetry.
    if (InWorld.GetNetMode() == NM_Client) return;

    LoadConfig();

    FTimerManager& TM = InWorld.GetTimerManager();
    TM.SetTimer(PosTimer, FTimerDelegate::CreateUObject(this, &USquadAARTelemetrySubsystem::TickPositions), PosIntervalSec, true);
    TM.SetTimer(SlowTimer, FTimerDelegate::CreateUObject(this, &USquadAARTelemetrySubsystem::TickSlow), SlowIntervalSec, true);
    TM.SetTimer(RoleTimer, FTimerDelegate::CreateUObject(this, &USquadAARTelemetrySubsystem::TickRoles), RoleIntervalSec, true);

    if (bEmitProjectiles)
    {
        SpawnHandle = InWorld.AddOnActorSpawnedHandler(
            FOnActorSpawned::FDelegate::CreateUObject(this, &USquadAARTelemetrySubsystem::HandleActorSpawned));
    }

    // Non-matching line (ignored by the parser) — handy operator breadcrumb.
    UE_LOG(LogSquadStats, Log, TEXT("Init: posHz=%s slowSec=%s roleSec=%s projectiles=%d cqb=%d sdk=%d"),
        *F1(1.0f / PosIntervalSec), *F1(SlowIntervalSec), *F1(RoleIntervalSec),
        bEmitProjectiles ? 1 : 0, bCQB ? 1 : 0, SQUADAAR_HAVE_SQ_SDK);
}

void USquadAARTelemetrySubsystem::Deinitialize()
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(PosTimer);
        World->GetTimerManager().ClearTimer(SlowTimer);
        World->GetTimerManager().ClearTimer(RoleTimer);
        if (SpawnHandle.IsValid()) World->RemoveOnActorSpawnedHandler(SpawnHandle);
    }
    Projectiles.Empty();
    Super::Deinitialize();
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

void USquadAARTelemetrySubsystem::TickPositions()
{
    EmitPlayerPositions();
}

void USquadAARTelemetrySubsystem::TickSlow()
{
    EmitTickets();
    EmitCapZones();
    EmitVehicles();
}

void USquadAARTelemetrySubsystem::TickRoles()
{
    EmitRoles();
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

void USquadAARTelemetrySubsystem::EmitPlayerPositions()
{
    UWorld* World = GetWorld();
    if (!World) return;
    const AGameStateBase* GS = World->GetGameState();
    if (!GS) return;

    for (const APlayerState* PS : GS->PlayerArray)
    {
        if (!PS) continue;
        const FString Eos = SquadAARSDK::GetEOSId(PS);
        if (Eos.IsEmpty()) continue; // bots / not-yet-authenticated

        const APawn* Pawn = SquadAARSDK::PawnOf(PS);
        const AController* Ctrl = SquadAARSDK::ControllerOf(PS);

        FVector Loc = FVector::ZeroVector;
        float Yaw = 0.f;
        float Hp = 0.f;
        FString State = TEXT("dead");
        if (Pawn)
        {
            Loc = Pawn->GetActorLocation();
            Yaw = Pawn->GetActorRotation().Yaw;
            Hp = SquadAARSDK::GetHealthPct(Pawn);
            State = SquadAARSDK::GetSoldierState(Pawn);
        }

        const FString CtrlName = Ctrl ? San(Ctrl->GetName()) : TEXT("none");
        const int32 Team = FMath::Clamp(SquadAARSDK::GetTeamId(PS), 0, 9);
        const int32 Squad = FMath::Max(SquadAARSDK::GetSquadId(PS), 0);
        const FString Role = San(SquadAARSDK::GetRoleName(PS));

        UE_LOG(LogSquadStats, Log,
            TEXT("PlayerPos: eos=%s ctrl=%s pos=%s,%s,%s yaw=%s hp=%s team=%d squad=%d role=%s state=%s"),
            *Eos, *CtrlName, *F1(Loc.X), *F1(Loc.Y), *F1(Loc.Z), *F1(Yaw), *F1(Hp),
            Team, Squad, *Role, *State);

        if (bCQB && Pawn)
        {
            const FRotator View = Ctrl ? Ctrl->GetControlRotation() : Pawn->GetActorRotation();
            UE_LOG(LogSquadStats, Log, TEXT("PlayerLook: eos=%s pitch=%s yaw=%s"),
                *Eos, *F1(View.Pitch), *F1(View.Yaw));
            UE_LOG(LogSquadStats, Log, TEXT("PlayerState: eos=%s stance=%s sprint=%d"),
                *Eos, *SquadAARSDK::GetStance(Pawn), SquadAARSDK::IsSprinting(Pawn) ? 1 : 0);
        }
    }
}

void USquadAARTelemetrySubsystem::EmitRoles()
{
    UWorld* World = GetWorld();
    if (!World) return;
    const AGameStateBase* GS = World->GetGameState();
    if (!GS) return;

    for (const APlayerState* PS : GS->PlayerArray)
    {
        if (!PS) continue;
        const FString Eos = SquadAARSDK::GetEOSId(PS);
        if (Eos.IsEmpty()) continue;
        const int32 Team = FMath::Clamp(SquadAARSDK::GetTeamId(PS), 0, 9);
        const int32 Squad = FMath::Max(SquadAARSDK::GetSquadId(PS), 0);
        UE_LOG(LogSquadStats, Log, TEXT("PlayerRole: eos=%s role=%s lead=%d team=%d squad=%d"),
            *Eos, *San(SquadAARSDK::GetRoleName(PS)), SquadAARSDK::IsLeader(PS) ? 1 : 0, Team, Squad);
    }
}

void USquadAARTelemetrySubsystem::EmitTickets()
{
#if SQUADAAR_HAVE_SQ_SDK
    UWorld* World = GetWorld();
    if (!World) return;
    if (const ASQGameState* GS = World->GetGameState<ASQGameState>())
    {
        // VERIFY: ticket accessors for your SDK. Emit one line per team.
        // UE_LOG(LogSquadStats, Log, TEXT("Tickets: team=1 tickets=%s"), *F1(GS->GetTeamOneTickets()));
        // UE_LOG(LogSquadStats, Log, TEXT("Tickets: team=2 tickets=%s"), *F1(GS->GetTeamTwoTickets()));
        (void)GS;
    }
#endif
}

void USquadAARTelemetrySubsystem::EmitCapZones()
{
#if SQUADAAR_HAVE_SQ_SDK
    UWorld* World = GetWorld();
    if (!World) return;
    // VERIFY: capture-zone class name (e.g. ASQCaptureZone / ASQCapturePoint).
    // for (TActorIterator<ASQCaptureZone> It(World); It; ++It)
    // {
    //     const ASQCaptureZone* Z = *It; if (!Z) continue;
    //     const FVector P = Z->GetActorLocation();
    //     UE_LOG(LogSquadStats, Log, TEXT("CapZone: flag=%s pos=%s,%s,%s team=%d progress=%s status=%s"),
    //         *San(Z->GetName()), *F1(P.X), *F1(P.Y), *F1(P.Z),
    //         Z->GetControllingTeam(), *F3(Z->GetProgress()), *San(Z->GetStatusString()));
    // }
#endif
}

void USquadAARTelemetrySubsystem::EmitVehicles()
{
#if SQUADAAR_HAVE_SQ_SDK
    UWorld* World = GetWorld();
    if (!World) return;
    for (TActorIterator<ASQVehicle> It(World); It; ++It)
    {
        const ASQVehicle* V = *It;
        if (!V) continue;
        const FVector P = V->GetActorLocation();
        const float Yaw = V->GetActorRotation().Yaw;
        // VERIFY: turret yaw, health and team accessors for your SDK.
        const float TYaw = Yaw;            // VERIFY: V->GetTurretYaw()
        const float Hp = 100.f;            // VERIFY: V->GetHealth()
        const float MaxHp = 100.f;         // VERIFY: V->GetMaxHealth()
        const int32 Team = 0;              // VERIFY: V->GetTeamID()
        UE_LOG(LogSquadStats, Log,
            TEXT("VehiclePos: veh=%s type=%s pos=%s,%s,%s yaw=%s tyaw=%s hp=%s/%s team=%d"),
            *San(V->GetName()), *San(V->GetClass()->GetName()),
            *F1(P.X), *F1(P.Y), *F1(P.Z), *F1(Yaw), *F1(TYaw), *F1(Hp), *F1(MaxHp), FMath::Clamp(Team, 0, 9));
        // VERIFY: per-component health → emit one VehicleComp line each:
        // UE_LOG(LogSquadStats, Log, TEXT("VehicleComp: veh=%s comp=%s hp=%s"), ...);
    }
#endif
}

// ---------------------------------------------------------------------------
// Actor lifecycle: projectiles, FOBs, deployables
// ---------------------------------------------------------------------------

void USquadAARTelemetrySubsystem::HandleActorSpawned(AActor* Actor)
{
    if (!Actor) return;
    const FString Cls = Actor->GetClass()->GetName();

    // Projectiles: capture origin now, emit the full from→to line on destruction
    // (impact). Class-name match needs no SDK headers — Squad rounds are
    // BP_*Projectile* actors.
    if (bEmitProjectiles && Cls.Contains(TEXT("Projectile")))
    {
        FProjInfo Info;
        Info.From = Actor->GetActorLocation();
        Info.Weapon = San(Cls);
        Info.ShooterEOS = InstigatorEOS(Actor);
        Info.SpawnTime = GetWorld() ? GetWorld()->GetTimeSeconds() : 0.0;
        Projectiles.Add(Actor, Info);
        Actor->OnDestroyed.AddDynamic(this, &USquadAARTelemetrySubsystem::HandleProjectileDestroyed);
        return;
    }

    // FOB radius actor (BP_FOBRadius_C in vanilla logs) → FobCreated/FobDestroyed.
    if (Cls.Contains(TEXT("FOBRadius")) || Cls.Contains(TEXT("RadioMast")))
    {
        const FVector P = Actor->GetActorLocation();
        UE_LOG(LogSquadStats, Log, TEXT("FobCreated: fob=%s team=%d pos=%s,%s,%s creator=%s"),
            *San(Actor->GetName()), FMath::Clamp(InstigatorTeam(Actor), 0, 9),
            *F1(P.X), *F1(P.Y), *F1(P.Z), *InstigatorEOS(Actor));
        Actor->OnDestroyed.AddDynamic(this, &USquadAARTelemetrySubsystem::HandleFobDestroyed);
        return;
    }

    // Other deployables (emplacements, sandbags, HASCO…) → Deployable.
    if (Cls.Contains(TEXT("Deployable")))
    {
        const FVector P = Actor->GetActorLocation();
        UE_LOG(LogSquadStats, Log, TEXT("Deployable: type=%s team=%d pos=%s,%s,%s"),
            *San(Cls), FMath::Clamp(InstigatorTeam(Actor), 0, 9), *F1(P.X), *F1(P.Y), *F1(P.Z));
    }
}

void USquadAARTelemetrySubsystem::HandleProjectileDestroyed(AActor* DestroyedActor)
{
    FProjInfo Info;
    if (!Projectiles.RemoveAndCopyValue(DestroyedActor, Info)) return;
    if (!DestroyedActor) return;

    const FVector To = DestroyedActor->GetActorLocation();
    const double Now = GetWorld() ? GetWorld()->GetTimeSeconds() : Info.SpawnTime;
    const double Dt = FMath::Max(Now - Info.SpawnTime, 0.001);
    const double SpeedMS = (FVector::Dist(Info.From, To) / 100.0) / Dt; // cm→m / s

    // Geometry only: SquadAAR pairs the actual hit/victim from the vanilla
    // wound/die lines, so hit=0 victim=- here is correct and still drives the
    // line-of-sight / terrain-occlusion analysis.
    UE_LOG(LogSquadStats, Log,
        TEXT("Projectile: shooter=%s weapon=%s from=%s,%s,%s to=%s,%s,%s speed=%s hit=0 victim=-"),
        *Info.ShooterEOS, *Info.Weapon,
        *F1(Info.From.X), *F1(Info.From.Y), *F1(Info.From.Z),
        *F1(To.X), *F1(To.Y), *F1(To.Z), *F1(SpeedMS));
}

void USquadAARTelemetrySubsystem::HandleFobDestroyed(AActor* DestroyedActor)
{
    if (!DestroyedActor) return;
    const FVector P = DestroyedActor->GetActorLocation();
    UE_LOG(LogSquadStats, Log, TEXT("FobDestroyed: fob=%s team=%d pos=%s,%s,%s"),
        *San(DestroyedActor->GetName()), FMath::Clamp(InstigatorTeam(DestroyedActor), 0, 9),
        *F1(P.X), *F1(P.Y), *F1(P.Z));
}
