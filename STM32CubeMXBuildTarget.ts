import {ProjectOptions, Target, Tasks} from "pango";
import {STM32CubeMXGenTask} from "./STM32CubeMXGenTask";

export class STM32CubeMXBuildTarget extends Target {
    getTasks(projectOptions: ProjectOptions): Promise<Tasks> {
        return Promise.resolve({
            'stm32cubemx-gen': new STM32CubeMXGenTask()
        });
    }

    get helpMessage(): string {
        return 'Build STM32CubeMX files';
    }
}