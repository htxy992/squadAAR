// Copyright SquadAAR.
#include "Modules/ModuleManager.h"
#include "SquadAARTelemetryLog.h"

DEFINE_LOG_CATEGORY(LogSquadStats);

// No custom startup/shutdown work — the USquadAARTelemetrySubsystem drives
// everything and is created automatically per game world.
IMPLEMENT_MODULE(FDefaultModuleImpl, SquadAARTelemetry);
