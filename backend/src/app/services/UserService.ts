import { User } from "../models/UserSchema";


interface CreateUserInput {
    id: string;
    name: string;
    image: string;
    access_token?: string;
    refresh_token?: string;
}

export class UserService {
    private static instance: UserService;


    // singleton design pattern
    public static getInstance(): UserService {
        if (!UserService.instance) {
            UserService.instance = new UserService();
        }
        return UserService.instance;
    }






    async createUser(props: CreateUserInput) {
        const { id, name, image, access_token, refresh_token } = props;

        const existingUser = await User.findOne({ githubId: id });

        if (!existingUser) {
            const user = new User({
                name,
                image,
                access_token,
                refresh_token,
                githubId: id,
            });

            const newUser = await user.save();

            return {
                authData: newUser.toObject(),
            };

        } else {
            const updatedUser = await User.findByIdAndUpdate(
                existingUser._id,
                {
                    access_token,
                    refresh_token,
                    name,   
                    image,  
                },
                { new: true, runValidators: true }
            );

            return {
                authData: updatedUser?.toObject(),
            };
        }
    }





}
