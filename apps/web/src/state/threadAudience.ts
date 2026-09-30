import { createContext } from "react";

export const ThreadAudienceContext = createContext<"work" | "idea">("work");
