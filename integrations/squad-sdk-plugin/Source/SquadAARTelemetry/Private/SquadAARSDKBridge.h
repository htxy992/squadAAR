// Copyright SquadAAR.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerState.h"
#include "GameFramework/Controller.h"
#include "GameFramework/Pawn.h"

/**
 * ===========================================================================
 *  SDK INTEGRATION SURFACE
 * ===========================================================================
 *  This header is the ONLY place that needs Squad-specific knowledge. The rest
 *  of the module is stock Unreal and compiles/works as-is.
 *
 *  Two build modes, switched by SQUADAAR_HAVE_SQ_SDK:
 *
 *    0 (default) — builds with no Squad headers. You still get:
 *        PlayerPos (position, heading, controller name, identity), Projectile
 *        (from/to → line-of-sight & terrain analysis), FobCreated/FobDestroyed,
 *        Deployable. team/squad/role/health/state fall back to defaults.
 *
 *    1           — include your SDK's gameplay headers below and fill in the
 *        getters marked `VERIFY`. Unlocks correct team/squad/role/health/state,
 *        tickets, cap zones and vehicle health for the full replay.
 *
 *  Class NAMES used here (ASQPlayerState/ASQSoldier/ASQVehicle/…) follow Squad's
 *  conventions; three are confirmed verbatim from real server logs
 *  (ASQSoldier::Die(), ASQSoldier::Wound(), ASQPlayerController::OnPossess(),
 *  ASQDeployable::TakeDamage()). The MEMBER/getter names are the parts that vary
 *  by SDK version — every one is marked `VERIFY` so you have a single, short
 *  checklist to confirm against your headers.
 * ===========================================================================
 */

#ifndef SQUADAAR_HAVE_SQ_SDK
#define SQUADAAR_HAVE_SQ_SDK 0
#endif

#if SQUADAAR_HAVE_SQ_SDK
// VERIFY: include paths differ between SDK versions — point these at the headers
// that declare the Squad gameplay classes. Add the owning module to
// PrivateDependencyModuleNames in SquadAARTelemetry.Build.cs.
#include "Player/SQPlayerState.h"
#include "Soldier/SQSoldier.h"
#include "Vehicles/SQVehicle.h"
#include "GameMode/SQGameState.h"
#endif

namespace SquadAARSDK
{
    /** The PlayerController that owns this PlayerState (server-side). */
    inline AController* ControllerOf(const APlayerState* PS)
    {
        return PS ? Cast<AController>(PS->GetOwner()) : nullptr;
    }

    /** The pawn this PlayerState is currently controlling, if any. */
    inline APawn* PawnOf(const APlayerState* PS)
    {
        if (const AController* C = ControllerOf(PS)) return C->GetPawn();
        return nullptr;
    }

    /**
     * EOS product user id (hex) for a player. Stable across SDK versions: we read
     * the unique-net-id string (e.g. "RedpointEOS:0002ab…") and return its
     * longest hex run, which is the EOS id SquadAAR keys players on. No Squad
     * headers required.
     */
    inline FString GetEOSId(const APlayerState* PS)
    {
        if (!PS) return FString();
        const FString Raw = PS->GetUniqueId().IsValid() ? PS->GetUniqueId()->ToString() : FString();
        auto IsHex = [](TCHAR c)
        {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        };
        FString Best, Cur;
        for (int32 i = 0; i <= Raw.Len(); ++i)
        {
            if (i < Raw.Len() && IsHex(Raw[i]))
            {
                Cur.AppendChar(Raw[i]);
            }
            else
            {
                if (Cur.Len() > Best.Len()) Best = Cur;
                Cur.Reset();
            }
        }
        return Best;
    }

    // -- Squad-typed enrichment ---------------------------------------------
    // With SQUADAAR_HAVE_SQ_SDK off these return safe defaults so the module
    // still builds and emits geometry. Turn it on and fill the VERIFY getters.

    inline int32 GetTeamId(const APlayerState* PS)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQPlayerState* SP = Cast<ASQPlayerState>(PS))
            return SP->GetTeamID(); // VERIFY: may be GetTeam()->GetTeamId()
#endif
        (void)PS;
        return 0;
    }

    inline int32 GetSquadId(const APlayerState* PS)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQPlayerState* SP = Cast<ASQPlayerState>(PS))
            return SP->GetSquadID(); // VERIFY: may be GetSquad()->GetSquadId(), 0 == no squad
#endif
        (void)PS;
        return 0;
    }

    inline bool IsLeader(const APlayerState* PS)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQPlayerState* SP = Cast<ASQPlayerState>(PS))
            return SP->IsSquadLeader(); // VERIFY
#endif
        (void)PS;
        return false;
    }

    /** Role/kit name; SquadAAR maps it to an Elo pool (SL/Medic/LAT/HAT/CE/…). */
    inline FString GetRoleName(const APlayerState* PS)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQPlayerState* SP = Cast<ASQPlayerState>(PS))
        {
            // VERIFY: role accessor + how to get a stable name. The returned
            // string only needs to *contain* SL/Medic/LAT/HAT/Engineer/etc. for
            // pool mapping (see src/elo/pools.ts infantryPoolForRole).
            if (const UObject* Role = SP->GetCurrentRole())
                return Role->GetName();
        }
#endif
        (void)PS;
        return TEXT("Unknown");
    }

    /** Health as a 0..100 percentage. */
    inline float GetHealthPct(const APawn* Pawn)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQSoldier* S = Cast<ASQSoldier>(Pawn))
        {
            const float Max = S->GetMaxHealth(); // VERIFY
            return Max > 0.f ? FMath::Clamp(100.f * S->GetHealth() / Max, 0.f, 100.f) : 0.f; // VERIFY
        }
#endif
        return Pawn ? 100.f : 0.f;
    }

    /** "alive" | "wound" | "dead" — matches PlayerPos state=<\w+>. */
    inline FString GetSoldierState(const APawn* Pawn)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQSoldier* S = Cast<ASQSoldier>(Pawn))
        {
            if (S->IsDead()) return TEXT("dead");          // VERIFY
            if (S->IsIncapacitated()) return TEXT("wound"); // VERIFY (downed/revivable)
            return TEXT("alive");
        }
#endif
        return Pawn ? TEXT("alive") : TEXT("dead");
    }

    // -- CQB extras (only used when SQUADAAR_CQB=1) --------------------------

    inline FString GetStance(const APawn* Pawn)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQSoldier* S = Cast<ASQSoldier>(Pawn))
        {
            if (S->IsProne()) return TEXT("prone");      // VERIFY
            if (S->IsCrouched()) return TEXT("crouch");  // VERIFY (AActor::bIsCrouched exists generically)
        }
#endif
        if (const ACharacter* C = Cast<ACharacter>(Pawn))
            return C->bIsCrouched ? TEXT("crouch") : TEXT("stand");
        return TEXT("stand");
    }

    inline bool IsSprinting(const APawn* Pawn)
    {
#if SQUADAAR_HAVE_SQ_SDK
        if (const ASQSoldier* S = Cast<ASQSoldier>(Pawn))
            return S->IsSprinting(); // VERIFY
#endif
        (void)Pawn;
        return false;
    }
}
