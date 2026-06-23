// Copyright SquadAAR.
#pragma once

#include "CoreMinimal.h"

/**
 * Custom log category. `UE_LOG(LogSquadStats, Log, TEXT("..."))` writes
 *
 *     [YYYY.MM.DD-HH.MM.SS:mmm][frame]LogSquadStats: <message>
 *
 * into SquadGame.log — exactly the prefix SquadAAR's parser keys on
 * (see src/parser/patterns.ts).
 *
 * IMPORTANT — use *Log* verbosity, never Display/Warning. At Log verbosity the
 * engine emits "LogSquadStats: <msg>" with no verbosity infix, which is what the
 * regexes expect. Display would emit "LogSquadStats: Display: <msg>" and miss.
 * (The stock server already logs LogSquad/LogSquadTrace at Log verbosity, so a
 * custom category at Log verbosity is emitted on the same builds.)
 */
DECLARE_LOG_CATEGORY_EXTERN(LogSquadStats, Log, All);
