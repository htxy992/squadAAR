// Copyright SquadAAR. Build rules for the SquadAARTelemetry runtime module.
using UnrealBuildTool;

public class SquadAARTelemetry : ModuleRules
{
    public SquadAARTelemetry(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // Stock-UE only: positions, projectiles, FOB/deployable spawn+destroy and
        // identity all work against these. No Squad headers required to compile.
        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine"
        });

        // To unlock team/squad/role/health/state, tickets, cap zones and vehicle
        // health, flip SQUADAAR_HAVE_SQ_SDK on and add the Squad gameplay module
        // your SDK exposes (the module that owns ASQPlayerState/ASQSoldier/…).
        // See Private/SquadAARSDKBridge.h.
        //
        // PublicDefinitions.Add("SQUADAAR_HAVE_SQ_SDK=1");
        // PrivateDependencyModuleNames.Add("Squad");
    }
}
