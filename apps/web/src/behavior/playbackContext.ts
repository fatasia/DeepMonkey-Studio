import { createContext, useContext } from "react";
import type { ApplicationPlaybackSession } from "./ApplicationPlaybackSession";

export const PlaybackContext = createContext<ApplicationPlaybackSession | undefined>(undefined);
export const usePlaybackSession = () => useContext(PlaybackContext);
