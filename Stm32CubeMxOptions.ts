import {ProjectOptions} from "pango";

export interface Stm32CubeMxOptions {
    stm32cubemx?: string;
    iocFile?: string;
    flashStart?: number;
    eePromStart?: number;
}

export function getStm32CubeMxOptions(projectOptions: ProjectOptions): Stm32CubeMxOptions {
    return projectOptions.stm32CubeMx = {
        stm32cubemx: 'stm32cubemx',
        ...(projectOptions.stm32CubeMx)
    };
}
